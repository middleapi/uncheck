import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

export interface TerminalOptions {
  readonly cwd?: string
  readonly env?: Env
  /** Typed one at a time once the output shows `waitFor`. */
  readonly keys?: ReadonlyArray<string>
  readonly waitFor?: string
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

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'uncheck-e2e-')))
const GIT_CONFIG = join(ROOT, 'gitconfig')
const SHIMS = join(ROOT, 'bin')

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

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// A stray path would run git or the CLI in the repository these tests live in.
function inside(path: string): string {
  if (!path.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`${path} is outside ${ROOT}`)
  }

  return path
}

export function temporaryDirectory(): string {
  return mkdtempSync(join(ROOT, 'tmp-'))
}

/** The environment of every process the tests start, free of whatever the machine or a git hook set. */
export function environment(overrides: Env = {}): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([key]) => !/^(?:GIT_\w+|CI|FORCE_COLOR|NO_COLOR|NODE_DISABLE_COLORS)$/.test(key),
  )

  return {
    ...Object.fromEntries(inherited),
    PATH: `${SHIMS}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'uncheck',
    GIT_AUTHOR_EMAIL: 'uncheck@example.com',
    GIT_COMMITTER_NAME: 'uncheck',
    GIT_COMMITTER_EMAIL: 'uncheck@example.com',
    // Functions deserialized from the compile cache report imprecise coverage.
    NODE_DISABLE_COMPILE_CACHE: '1',
    ...overrides,
  }
}

export function git(cwd: string, args: ReadonlyArray<string>, env?: Env): string {
  return execFileSync('git', args, {
    cwd: inside(cwd),
    env: environment(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

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

/** Runs `command` in a pseudo-terminal, which merges stdout and stderr into `stdout`. */
export function runInTerminal(
  command: ReadonlyArray<string>,
  { cwd, env, keys = [], waitFor }: Omit<TerminalOptions, 'cwd'> & { readonly cwd: string },
): Promise<Run> {
  const args =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-qfec', command.map(shellQuote).join(' '), '/dev/null']

  return new Promise((resolve, reject) => {
    const child = spawn('script', args, { cwd: inside(cwd), env: environment(env) })
    let stdout = ''
    let typing = false

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk

      if (!typing && waitFor !== undefined && stripVTControlCharacters(stdout).includes(waitFor)) {
        typing = true
        keys.forEach((key, index) => setTimeout(() => child.stdin.write(key), 100 * (index + 1)))
      }
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

/** The lines uncheck itself prints, without the timings that differ between runs. */
export function report(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => /^(?:uncheck (?:staged )?in |[▶✔✘○] | {2}rerun )/.test(line))
    .map((line) => line.replace(/ (?:\d+ms|\d+\.\ds)$/, ''))
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
        rmSync(target, { recursive: true, force: true })
        continue
      }

      mkdirSync(dirname(target), { recursive: true })
      // Tools are linked from the shared pnpm store, which a write through the link would corrupt.
      inside(realpathSync(existsSync(target) ? target : dirname(target)))
      writeFileSync(target, typeof content === 'string' ? content : json(content, file))
    }

    return this
  }

  read(file: string): string {
    return readFileSync(this.path(file), 'utf8')
  }

  exists(file: string): boolean {
    return existsSync(this.path(file))
  }

  link(file: string, target: string): this {
    mkdirSync(dirname(this.path(file)), { recursive: true })
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
  created.write({ '.gitignore': 'node_modules\ndist\n', ...files })

  if (git !== 'none') {
    created.git('init', '--quiet', '--initial-branch=main')
  }

  if (git === 'commit') {
    created.commit('init')
  }

  return created
}

const OXLINT_CONFIG = { rules: { 'no-var': 'error' } }

function compilerOptions(extra: object = {}) {
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

export interface Layout {
  readonly name: string
  readonly create: (files?: Files, options?: ProjectOptions) => Project
  /** Where the code of the package the tests work on lives: `''` or a folder ending in `/`. */
  readonly app: string
}

export const LAYOUTS: ReadonlyArray<Layout> = [
  { name: 'single repo', create: singleRepo, app: '' },
  { name: 'monorepo', create: monorepo, app: 'packages/app/' },
]
