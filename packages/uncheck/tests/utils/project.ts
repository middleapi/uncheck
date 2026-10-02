import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

export const TOOLS = ['sherif', 'oxlint', 'oxfmt', 'typescript'] as const

export type Tool = (typeof TOOLS)[number]

export type Files = Readonly<Record<string, string | object | null>>

export type Env = Readonly<Record<string, string | undefined>>

export interface ProjectOptions {
  readonly tools?: ReadonlyArray<Tool>
  readonly git?: 'none' | 'init' | 'commit'
}

export interface RunOptions {
  /** Relative to the project. */
  readonly cwd?: string
  readonly input?: string
  readonly env?: Env
}

export interface Answer {
  /** Typed one at a time once the output shows `waitFor`. */
  readonly keys: ReadonlyArray<string>
  readonly waitFor: string
}

export interface TerminalOptions {
  readonly cwd?: string
  readonly env?: Env
  readonly answers?: ReadonlyArray<Answer>
}

export interface Run {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url))
const REGISTER = fileURLToPath(new URL('register.ts', import.meta.url))
export const CLI = [process.execPath, '--import', REGISTER, join(PACKAGE, 'src/bin.ts')] as const

/** What the CLI and the tools it runs read above a project, so one above the tests leaks into them all. */
const PROJECT_MARKERS = [
  'package.json',
  'node_modules',
  'tsconfig.json',
  '.pnp.cjs',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  '.editorconfig',
  '.oxfmtrc.json',
  '.oxfmtrc.jsonc',
  'oxfmt.config.ts',
  'oxfmt.config.mts',
  '.oxlintrc.json',
  '.oxlintrc.jsonc',
  'oxlint.config.ts',
  'oxlint.config.mts',
  '.eslintignore',
  '.gitignore',
]

for (let dir = realpathSync(tmpdir()); ; dir = dirname(dir)) {
  const marker = PROJECT_MARKERS.find((name) => existsSync(join(dir, name)))

  if (marker !== undefined) {
    throw new Error(
      `${join(dir, marker)} would leak into every test project, point TMPDIR elsewhere`,
    )
  }

  if (dir === dirname(dir)) {
    break
  }
}

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'uncheck-e2e-')))
const GIT_CONFIG = join(ROOT, 'gitconfig')
const SHIMS = join(ROOT, 'bin')
export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

writeFileSync(GIT_CONFIG, '')
mkdirSync(SHIMS)
writeFileSync(
  join(SHIMS, 'pnpm'),
  [
    '#!/bin/sh',
    '[ "$1" = exec ] && shift',
    'dir=$PWD',
    'until [ -x "$dir/node_modules/.bin/$1" ] || [ "$dir" = / ]; do dir=$(dirname "$dir"); done',
    'bin=$1',
    'shift',
    'exec "$dir/node_modules/.bin/$bin" "$@"',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

// A folder a test left unreadable or read-only would stop the removal of the temporary files.
function restorePermissions(dir: string): void {
  chmodSync(dir, 0o755)

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      restorePermissions(join(dir, entry.name))
    }
  }
}

afterAll(() => {
  restorePermissions(ROOT)
  rmSync(ROOT, { recursive: true, force: true })
})

// Root reads and writes files whatever their mode, so chmod cannot make anything fail for it.
export const PERMISSIONS_ENFORCED = process.getuid?.() !== 0

// A stray path would run git or the CLI in the repository these tests live in.
function inside(path: string): string {
  if (!path.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`${path} is outside ${ROOT}`)
  }

  return path
}

// Tools are linked from the shared pnpm store, which a change made through the link would corrupt.
function landsInside(path: string): string {
  let existing = path

  while (!existsSync(existing)) {
    existing = dirname(existing)
  }

  inside(realpathSync(existing))

  return path
}

export function temporaryDirectory(): string {
  return mkdtempSync(join(ROOT, 'tmp-'))
}

// Tools change their output on CI, under GitHub Actions and in the AI agents they detect, so nothing
// else of the machine's environment reaches the processes the tests start.
const INHERITED = new Set(['HOME', 'TMPDIR', 'NODE_V8_COVERAGE'])

/** The environment of every process the tests start, the same on every machine. */
export function environment(overrides: Env = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => INHERITED.has(key))),
    PATH: `${SHIMS}${delimiter}${process.env.PATH}`,
    // git translates the messages tests assert to the language of the machine.
    LC_ALL: 'C',
    // Node paints nothing in a terminal of unknown type.
    TERM: 'xterm-256color',
    GIT_CEILING_DIRECTORIES: ROOT,
    GIT_CONFIG_GLOBAL: GIT_CONFIG,
    // git still reads ~/.config/git/ignore and attributes when GIT_CONFIG_GLOBAL points elsewhere, and
    // /etc/gitattributes under GIT_CONFIG_NOSYSTEM.
    XDG_CONFIG_HOME: join(ROOT, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'uncheck',
    GIT_AUTHOR_EMAIL: 'uncheck@example.com',
    GIT_COMMITTER_NAME: 'uncheck',
    GIT_COMMITTER_EMAIL: 'uncheck@example.com',
    // Functions deserialized from the compile cache report imprecise coverage.
    ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_DISABLE_COMPILE_CACHE: '1' }),
    ...overrides,
  }
}

/** An environment whose `git` first runs the shell `script`, which finds the real git in `$GIT`. */
export function wrappedGit(script: string): Env {
  const shims = temporaryDirectory()

  writeFileSync(join(shims, 'git'), `#!/bin/sh\nGIT='${REAL_GIT}'\n${script}\nexec "$GIT" "$@"\n`, {
    mode: 0o755,
  })

  return { PATH: `${shims}${delimiter}${environment().PATH}` }
}

/** A git config file holding `content`, for GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM. */
export function gitConfig(content: string): string {
  const file = join(temporaryDirectory(), 'gitconfig')

  writeFileSync(file, content)

  return file
}

export function git(cwd: string, args: ReadonlyArray<string>, env?: Env): string {
  return execFileSync('git', args, {
    cwd: inside(cwd),
    env: environment(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export const DUBIOUS_OWNERSHIP: Env = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }

export function run(
  command: ReadonlyArray<string>,
  { cwd, input = '', env }: Omit<RunOptions, 'cwd'> & { readonly cwd: string },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: inside(cwd),
      env: environment(env),
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }))
    child.stdin.end(input)
  })
}

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

export const DOWN = '\u001B[B'
export const SPACE = ' '
export const ENTER = '\r'

export function fromAnswer(output: string, question: string): string {
  return output.slice(output.lastIndexOf(`✔ ${question}`))
}

/** Runs `command` in a pseudo-terminal, which merges stdout and stderr into `stdout`. */
export function runInTerminal(
  command: ReadonlyArray<string>,
  { cwd, env, answers = [] }: Omit<TerminalOptions, 'cwd'> & { readonly cwd: string },
): Promise<Run> {
  // Without exec, the shell that script starts also gets Ctrl-C and exits 130 whatever the command does.
  const args =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-qfec', `exec ${command.map(shellQuote).join(' ')}`, '/dev/null']

  return new Promise((resolve, reject) => {
    const child = spawn('script', args, { cwd: inside(cwd), env: environment(env) })
    let stdout = ''
    let answered = 0
    let shownFrom = 0

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk

      const answer = answers[answered]

      if (answer === undefined) {
        return
      }

      const shown = stripVTControlCharacters(stdout).indexOf(answer.waitFor, shownFrom)

      if (shown === -1) {
        return
      }

      answered += 1
      shownFrom = shown + answer.waitFor.length
      answer.keys.forEach((key, index) =>
        setTimeout(() => child.stdin.write(key), 100 * (index + 1)),
      )
    })
    child.on('error', reject)
    child.on('close', (exitCode, signal) =>
      resolve({
        exitCode,
        signal,
        stdout: stripVTControlCharacters(stdout).replaceAll('\r\n', '\n'),
        stderr: '',
      }),
    )
  })
}

/** The lines uncheck itself prints, without colors and the timings that differ between runs. */
export function report(output: string): string[] {
  return stripVTControlCharacters(output)
    .split('\n')
    .filter((line) => /^(?:uncheck (?:staged )?in |[▶✔✘○] | {2}rerun )/.test(line))
    .map((line) => line.replace(/ (?:\d+ms|\d+\.\ds)$/, ''))
}

/** How the CLI prints the error that stops a run. */
export function cliError(message: string): string {
  return `\nERROR\n  ${message}\n`
}

/** JSON the way oxfmt writes it, so the files a test adds pass the format check. */
function json(value: object, file: string): string {
  const text = JSON.stringify(value, null, 2)

  if (basename(file) === 'package.json') {
    return `${text}\n`
  }

  const primitive = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?[\d.e+-]+|true|false|null)`
  const list = new RegExp(String.raw`\[\n\s*(${primitive}(?:,\n\s*${primitive})*)\n\s*\]`, 'g')

  return `${text.replace(list, (_, items: string) => `[${items.split(/,\n\s*/).join(', ')}]`)}\n`
}

export class Project {
  constructor(readonly dir: string) {}

  path(...segments: ReadonlyArray<string>): string {
    return join(this.dir, ...segments)
  }

  write(files: Files): this {
    for (const [file, content] of Object.entries(files)) {
      const target = this.path(file)

      if (content === null) {
        landsInside(dirname(target))
        rmSync(target, { recursive: true, force: true })
        continue
      }

      landsInside(target)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, typeof content === 'string' ? content : json(content, file))
    }

    return this
  }

  /** Rewrites the JSON `file` with what `change` makes of it. */
  update(file: string, change: (value: Record<string, unknown>) => object): this {
    return this.write({ [file]: change(JSON.parse(this.read(file)) as Record<string, unknown>) })
  }

  read(file: string): string {
    return readFileSync(this.path(file), 'utf8')
  }

  mode(file: string): number {
    return statSync(this.path(file)).mode & 0o7777
  }

  chmod(file: string, mode: number): this {
    chmodSync(landsInside(this.path(file)), mode)

    return this
  }

  /** `text` with the folder of the project, which differs between runs, as `<project>`. */
  normalize(text: string): string {
    return text.replaceAll(this.dir, '<project>')
  }

  exists(file: string): boolean {
    return existsSync(this.path(file))
  }

  link(file: string, target: string): this {
    mkdirSync(landsInside(dirname(this.path(file))), { recursive: true })
    symlinkSync(target, this.path(file))

    return this
  }

  /** Installs a stand-in for `tool` that runs `script` with node, in place of the real one. */
  fake(tool: Tool, script: string): this {
    const bin = tool === 'typescript' ? 'tsc' : tool

    return this.write({
      [`node_modules/${tool}`]: null,
      [`node_modules/${tool}/package.json`]: { name: tool, bin: { [bin]: 'bin.js' } },
      [`node_modules/${tool}/bin.js`]: script,
    })
  }

  git(...args: ReadonlyArray<string>): string {
    return git(this.dir, args)
  }

  /** Writes `files` and stages them as they are, even names that look like globs. */
  stage(files: Files): this {
    this.write(files)
    this.git('--literal-pathspecs', 'add', '--all', '--', ...Object.keys(files))

    return this
  }

  commit(message = 'change'): this {
    this.git('add', '--all')
    this.git('commit', '--quiet', '--no-verify', `--message=${message}`)

    return this
  }

  uncheck(args: ReadonlyArray<string> = [], options: RunOptions = {}): Promise<Run> {
    return run([...CLI, ...args], { ...options, cwd: this.path(options.cwd ?? '.') })
  }

  uncheckInTerminal(args: ReadonlyArray<string>, options: TerminalOptions = {}): Promise<Run> {
    return runInTerminal([...CLI, ...args], { ...options, cwd: this.path(options.cwd ?? '.') })
  }
}

export function commitWithHooks(project: Project, ...args: ReadonlyArray<string>): Promise<Run> {
  return run(['git', 'commit', '--quiet', ...args], { cwd: project.dir })
}

export function commitOnSide(project: Project, files: Files): Project {
  project.git('checkout', '--quiet', '-b', 'side')
  project.write(files).commit('side')
  project.git('checkout', '--quiet', 'main')

  return project
}

function install(project: Project, tools: ReadonlyArray<Tool>): void {
  for (const tool of tools) {
    project.link(`node_modules/${tool}`, realpathSync(join(PACKAGE, 'node_modules', tool)))
  }

  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { default: string }>
  }

  for (const target of Object.values(manifest.exports)) {
    if (typeof target === 'object') {
      const source = join(
        PACKAGE,
        target.default.replace('./dist/', 'src/').replace(/\.mjs$/, '.ts'),
      )

      project.write({
        [`node_modules/uncheck/${target.default}`]: `export * from '${pathToFileURL(source)}'\n`,
      })
    }
  }

  project
    .write({
      'node_modules/uncheck/package.json': manifest,
      'node_modules/.bin/uncheck': `#!/bin/sh\nexec ${CLI.map(shellQuote).join(' ')} "$@"\n`,
    })
    .link('node_modules/uncheck/tsconfig', join(PACKAGE, 'tsconfig'))
  chmodSync(project.path('node_modules/.bin/uncheck'), 0o755)
}

/** A project in a fresh directory, with the tools linked in as a package manager installs them. */
export function project(files: Files = {}, { tools = TOOLS, git = 'commit' }: ProjectOptions = {}) {
  const created = new Project(temporaryDirectory())

  install(created, tools)
  created.write({ '.gitignore': 'node_modules\ndist\n*.tsbuildinfo\n', ...files })

  if (git !== 'none') {
    created.git('init', '--quiet', '--initial-branch=main')
  }

  if (git === 'commit') {
    created.commit('init')
  }

  return created
}

const OXLINT_CONFIG = { rules: { 'no-var': 'error' } }

export function compilerOptions(extra: object = {}) {
  return {
    strict: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    types: [],
    ...extra,
  }
}

const TOOL_VERSIONS = {
  oxfmt: '^0.68.0',
  oxlint: '^1.83.0',
  sherif: '^1.13.0',
  typescript: '^7.0.2',
  uncheck: '^0.0.3',
}

/** One package at the top of the repository. */
export function singleRepo(files: Files = {}, options?: ProjectOptions): Project {
  return project(
    {
      'package.json': {
        name: 'app',
        version: '1.0.0',
        private: true,
        type: 'module',
        devDependencies: TOOL_VERSIONS,
      },
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
      '.oxlintrc.json': OXLINT_CONFIG,
      'tsconfig.json': { compilerOptions: compilerOptions({ noEmit: true }), include: ['src'] },
      'src/index.ts':
        'import { double } from "./utils";\n\nexport const answer: number = double(21);\n',
      'src/utils.ts': 'export function double(value: number): number {\n  return value * 2;\n}\n',
      ...files,
    },
    options,
  )
}

export const UTILS_NOT_FOUND =
  "src/index.ts(1,24): error TS2307: Cannot find module './utils' or its corresponding type declarations."

/** A pnpm workspace whose `app` package builds on its `core` package through project references. */
export function monorepo(files: Files = {}, options?: ProjectOptions): Project {
  const composite = compilerOptions({
    composite: true,
    emitDeclarationOnly: true,
    outDir: 'dist',
    rootDir: 'src',
  })

  const created = project(
    {
      'package.json': {
        name: 'monorepo',
        private: true,
        type: 'module',
        devDependencies: TOOL_VERSIONS,
        packageManager: 'pnpm@10.0.0',
      },
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
      '.oxlintrc.json': OXLINT_CONFIG,
      'tsconfig.json': {
        files: [],
        references: [{ path: 'packages/core' }, { path: 'packages/app' }],
      },
      'packages/core/package.json': {
        name: '@repo/core',
        version: '1.0.0',
        private: true,
        type: 'module',
        exports: { '.': { types: './dist/index.d.ts', default: './src/index.ts' } },
      },
      'packages/core/tsconfig.json': { compilerOptions: composite, include: ['src'] },
      'packages/core/src/index.ts':
        'export function double(value: number): number {\n  return value * 2;\n}\n',
      'packages/app/package.json': {
        name: '@repo/app',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: { '@repo/core': 'workspace:*' },
      },
      'packages/app/tsconfig.json': {
        compilerOptions: composite,
        references: [{ path: '../core' }],
        include: ['src'],
      },
      'packages/app/src/index.ts':
        'import { double } from "@repo/core";\n\nexport const answer: number = double(21);\n',
      ...files,
    },
    { ...options, git: 'none' },
  )

  created.link('packages/app/node_modules/@repo/core', '../../../core')

  if (options?.git !== 'none') {
    created.git('init', '--quiet', '--initial-branch=main')
  }

  if ((options?.git ?? 'commit') === 'commit') {
    created.commit('init')
  }

  return created
}

/** A checkout of `project` made with `git worktree add`, with the links an install would make. */
export function linkedWorktree(project: Project, app: string): Project {
  const worktree = new Project(join(temporaryDirectory(), 'linked'))

  project.git('worktree', 'add', '--quiet', worktree.dir)
  worktree.link('node_modules', project.path('node_modules'))

  if (app !== '') {
    worktree.link(`${app}node_modules/@repo/core`, '../../../core')
  }

  return worktree
}

export interface Layout {
  readonly name: string
  readonly create: (files?: Files, options?: ProjectOptions) => Project
  /** Where the code of the package the tests work on lives: `''` or a folder ending in `/`. */
  readonly app: string
  /** The line of the tsc run that checks the whole project. */
  readonly tsc: string
}

export const LAYOUTS: ReadonlyArray<Layout> = [
  { name: 'single repo', create: singleRepo, app: '', tsc: '▶ tsc -p tsconfig.json --noEmit' },
  { name: 'monorepo', create: monorepo, app: 'packages/app/', tsc: '▶ tsc -b tsconfig.json' },
]

export const FULL_OXLINT = '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern'

export const FULL_OXLINT_FIX =
  '▶ oxlint --fix --ignore-pattern=node_modules --no-error-on-unmatched-pattern'

export const FULL_OXFMT = '▶ oxfmt --check --no-error-on-unmatched-pattern'

export const FULL_OXFMT_FIX = '▶ oxfmt --no-error-on-unmatched-pattern'

export const SKIPPED_FOR_DELETIONS = [
  '○ sherif skipped, no package.json among the given files',
  '○ oxlint skipped, only deleted files',
  '○ oxfmt skipped, only deleted files',
]
