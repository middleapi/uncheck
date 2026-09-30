import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
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
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

/** The two shapes of repository every command is tested in. */
export const LAYOUTS = ['single', 'monorepo'] as const

export type Layout = (typeof LAYOUTS)[number]

export const TOOLS = ['sherif', 'oxlint', 'oxfmt', 'typescript'] as const

export type Tool = (typeof TOOLS)[number]

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url))
const REGISTER = new URL('register.mjs', import.meta.url).href
const BIN = pathToFileURL(join(PACKAGE, 'src/bin.ts')).href

const created: string[] = []

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true })
  }
})

export interface ProjectOptions {
  /** The tools installed in the top `node_modules`, all of them by default. */
  readonly tools?: ReadonlyArray<Tool>
  /** `git init` and commit everything, on by default. */
  readonly git?: boolean
  /** Files written over the fixture before the first commit. */
  readonly files?: Files
}

export type Files = Record<string, string | object | null>

export interface RunOptions {
  /** Where to run, relative to the top of the project. */
  readonly cwd?: string
  readonly stdin?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** Without ANSI styling. */
  readonly stdout: string
  readonly stderr: string
}

export interface Project {
  readonly layout: Layout
  /** The top of the project, and of its git repository. */
  readonly root: string
  /** The folder of a package: the top for a single package, `packages/app` in the monorepo. */
  readonly app: string
  /** `app` relative to the top, `''` for a single package. */
  readonly appDir: string
  /** The git config the commands see as the global one. */
  readonly globalConfig: string
  /** The environment every command of this project runs with. */
  readonly env: Record<string, string | undefined>
  path: (file: string) => string
  /** A path of the package `app`, relative to the top. */
  inApp: (file: string) => string
  write: (files: Files) => void
  read: (file: string) => string
  exists: (file: string) => boolean
  remove: (file: string) => void
  git: (...args: string[]) => string
  gitIn: (cwd: string, ...args: string[]) => string
  /** Commits everything, so later edits show up as changes. */
  commit: (message?: string) => void
  /** Runs `uncheck <args>` through its bin, the way a user or a hook does. */
  run: (args?: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>
}

/**
 * Copies a fixture repository into a temporary folder and installs it: the tools and uncheck itself
 * in the top `node_modules`, and in the monorepo its packages linked there as a workspace install
 * does. uncheck is installed as a package whose bin runs `src/bin.ts`, so hooks and package
 * managers reach the sources under test.
 */
export function createProject(layout: Layout, options: ProjectOptions = {}): Project {
  const { tools = TOOLS, git = true, files = {} } = options
  const root = realpathSync(mkdtempSync(join(tmpdir(), `uncheck-${layout}-`)))
  created.push(root)

  cpSync(join(FIXTURES, layout), root, { recursive: true })
  installUncheck(root)

  for (const tool of tools) {
    symlinkSync(
      realpathSync(join(PACKAGE, 'node_modules', tool)),
      join(root, 'node_modules', tool),
      'dir',
    )
  }

  if (layout === 'monorepo') {
    mkdirSync(join(root, 'node_modules/@monorepo'))

    for (const name of ['app', 'lib']) {
      symlinkSync(join(root, 'packages', name), join(root, 'node_modules/@monorepo', name), 'dir')
    }
  }

  const globalConfig = join(root, 'node_modules/.gitconfig')
  writeFileSync(
    globalConfig,
    '[user]\n\tname = uncheck\n\temail = uncheck@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  )

  const env = childEnv({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' })
  const appDir = layout === 'single' ? '' : 'packages/app'
  const path = (file: string) => join(root, file)

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: path(cwd), env, encoding: 'utf8' })

  const project: Project = {
    layout,
    root,
    app: path(appDir),
    appDir,
    globalConfig,
    env,
    path,
    inApp: (file) => (appDir === '' ? file : `${appDir}/${file}`),
    write: (entries) => {
      for (const [file, content] of Object.entries(entries)) {
        if (content === null) {
          rmSync(path(file), { recursive: true, force: true })
          continue
        }

        mkdirSync(dirname(path(file)), { recursive: true })
        writeFileSync(path(file), typeof content === 'string' ? content : formatJson(content))
      }
    },
    read: (file) => readFileSync(path(file), 'utf8'),
    exists: (file) => existsSync(path(file)),
    remove: (file) => rmSync(path(file), { recursive: true, force: true }),
    git: (...args) => gitIn('.', ...args),
    gitIn,
    commit: (message = 'commit') => {
      gitIn('.', 'add', '-A')
      gitIn('.', 'commit', '--quiet', '--allow-empty', '-m', message)
    },
    run: (args = [], runOptions = {}) =>
      runNode([path('node_modules/uncheck/bin.mjs'), ...args], {
        cwd: path(runOptions.cwd ?? '.'),
        stdin: runOptions.stdin,
        env: { ...env, ...runOptions.env },
      }),
  }

  project.write(files)

  if (git) {
    project.git('init', '--quiet')
    project.commit('init')
  }

  return project
}

/** Runs one scenario in both repository shapes. */
export const eachLayout = describe.each(LAYOUTS.map((layout) => ({ layout })))

/**
 * The environment of the test run without what would change how uncheck, git or the tools behave:
 * CI makes sherif refuse to fix, and git variables would point at the repository running the tests.
 */
function childEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }

  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') || ['CI', 'FORCE_COLOR', 'NO_COLOR'].includes(name)) {
      delete env[name]
    }
  }

  return { ...env, ...extra }
}

function installUncheck(root: string) {
  const dir = join(root, 'node_modules/uncheck')
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  const source = (file: string) => pathToFileURL(join(PACKAGE, 'src', file)).href

  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    formatJson({
      name: 'uncheck',
      version: manifest.version,
      type: 'module',
      bin: { uncheck: 'bin.mjs' },
      exports: {
        './oxfmt': './oxfmt.mjs',
        './oxlint': './oxlint.mjs',
        './tsconfig/middleapi': './tsconfig/middleapi/base.json',
        './tsconfig/middleapi/lib': './tsconfig/middleapi/lib.json',
        './package.json': './package.json',
      },
    }),
  )
  writeFileSync(
    join(dir, 'bin.mjs'),
    `#!${process.execPath}\nimport ${JSON.stringify(REGISTER)}\nawait import(${JSON.stringify(BIN)})\n`,
  )
  chmodSync(join(dir, 'bin.mjs'), 0o755)
  writeFileSync(
    join(dir, 'oxfmt.mjs'),
    `export * from ${JSON.stringify(source('presets/oxfmt.ts'))}\n`,
  )
  writeFileSync(
    join(dir, 'oxlint.mjs'),
    `export * from ${JSON.stringify(source('presets/oxlint.ts'))}\n`,
  )
  symlinkSync(join(PACKAGE, 'tsconfig'), join(dir, 'tsconfig'), 'dir')
  symlinkSync(
    relative(join(root, 'node_modules/.bin'), join(dir, 'bin.mjs')),
    join(root, 'node_modules/.bin/uncheck'),
  )
}

/** The path of the installed uncheck bin in a project, for hooks written by hand. */
export function uncheckBin(project: Project): string {
  return project.path('node_modules/uncheck/bin.mjs')
}

interface SpawnOptions {
  readonly cwd: string
  readonly stdin?: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Runs `node <args>` and collects what it printed. */
export function runNode(args: ReadonlyArray<string>, { cwd, stdin, env }: SpawnOptions) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) =>
      resolve({
        code,
        signal,
        stdout: stripVTControlCharacters(Buffer.concat(stdout).toString()),
        stderr: stripVTControlCharacters(Buffer.concat(stderr).toString()),
      }),
    )
    child.stdin.end(stdin ?? '')
  })
}

/**
 * JSON the way oxfmt prints it: objects over several lines, arrays on one when they fit, so config
 * files written by tests pass the format check.
 */
export function formatJson(value: unknown): string {
  return `${print(value, '')}\n`
}

function print(value: unknown, indent: string): string {
  const inner = `${indent}  `

  if (Array.isArray(value)) {
    const items = value.map((item) => print(item, inner))
    const flat = `[${items.join(', ')}]`

    return flat.length + indent.length <= 80 && !flat.includes('\n')
      ? flat
      : `[\n${items.map((item) => `${inner}${item}`).join(',\n')}\n${indent}]`
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)

    return entries.length === 0
      ? '{}'
      : `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${print(item, inner)}`).join(',\n')}\n${indent}}`
  }

  return JSON.stringify(value)
}
