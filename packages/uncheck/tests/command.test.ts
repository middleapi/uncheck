import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { NodeServices } from '@effect/platform-node'
import { Console, Effect, Stdio, Stream } from 'effect'
import { Command } from 'effect/unstable/cli'

import { hooks } from '../src/commands/hooks'
import { prepare } from '../src/commands/prepare'
import { staged } from '../src/commands/staged'
import { uncheck } from '../src/commands/uncheck'
import { CheckFailed } from '../src/errors'
import { middleapi as oxfmtPreset } from '../src/presets/oxfmt'
import { middleapi as oxlintPreset } from '../src/presets/oxlint'
import { fixture } from './fixture'

const cli = uncheck.pipe(Command.withSubcommands([staged, prepare, hooks]))
const SUBCOMMANDS = new Set(['staged', 'prepare', 'hooks', 'install', 'run'])

interface RunResult {
  readonly result: 'ok' | 'blocked' | CheckFailed
  /** Everything logged, one line each, without ANSI styling. */
  readonly stdout: string
  readonly stderr: string
}

/** Runs the CLI in `cwd`; the flag goes after the subcommand names so it lands on the command that runs. */
async function run(cwd: string, args: ReadonlyArray<string> = [], stdin = ''): Promise<RunResult> {
  let verbs = 0

  while (SUBCOMMANDS.has(args[verbs] ?? '')) {
    verbs++
  }

  const argv = [...args.slice(0, verbs), '--cwd', cwd, ...args.slice(verbs)]
  const stdout: string[] = []
  const stderr: string[] = []

  const capture: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...parts: ReadonlyArray<unknown>) => {
      stdout.push(parts.join(' '))
    },
    error: (...parts: ReadonlyArray<unknown>) => {
      stderr.push(parts.join(' '))
    },
  })

  const result = await Effect.runPromise(
    Command.runWith(cli, { version: '0.0.0' })(argv).pipe(
      Effect.map(() => 'ok' as const),
      Effect.catchTag('CheckFailed', (error) => Effect.succeed(error)),
      Effect.catchTag('StopBlocked', () => Effect.succeed('blocked' as const)),
      Effect.provideService(Console.Console, capture),
      Effect.provide(Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(stdin)) })),
      Effect.provide(NodeServices.layer),
    ),
  )

  return { result, stdout: text(stdout), stderr: text(stderr) }
}

/** Joins captured lines the way a terminal would show them, without ANSI styling. */
function text(lines: string[]): string {
  return stripVTControlCharacters(lines.map((line) => `${line}\n`).join(''))
}

const oxlintrc = { rules: { 'no-var': 'error' } }

const standaloneTsconfig = {
  compilerOptions: {
    noEmit: true,
    strict: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    types: [],
  },
  include: ['src', 'scripts'],
}

function compositeTsconfig(references: string[] = []) {
  return {
    compilerOptions: {
      composite: true,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      types: [],
    },
    references: references.map((path) => ({ path })),
    include: ['src'],
  }
}

describe('uncheck', { timeout: 120_000 }, () => {
  it('reports oxlint and oxfmt failures, fixes them with --fix, then passes', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'src/legacy.ts': 'var count = 1;\nexport { count };\n',
      'src/ugly.ts': 'export const   ugly = {a:1,\n b:2}\n',
    })

    const check = await run(dir)

    expect(check.result).toBeInstanceOf(CheckFailed)
    expect((check.result as CheckFailed).outcomes).toEqual([
      { name: 'sherif', status: 'skipped', reason: 'no package.json found' },
      { name: 'oxlint', status: 'failed' },
      { name: 'oxfmt', status: 'failed' },
      { name: 'tsc', status: 'passed' },
    ])
    expect(check.stdout).toContain('no-var')
    expect(check.stdout).toContain('✘ 2 of 3 checks failed: oxlint, oxfmt')
    expect(check.stdout).toContain('rerun with `--fix` to apply oxlint and oxfmt fixes')

    const fix = await run(dir, ['--fix'])

    expect(fix.result).toBe('ok')
    expect(fix.stdout).toContain('▶ oxlint --fix\n')
    expect(fix.stdout).toContain('▶ oxfmt\n')
    expect(readFileSync(join(dir, 'src/legacy.ts'), 'utf8')).toBe(
      'const count = 1;\nexport { count };\n',
    )
    expect(readFileSync(join(dir, 'src/ugly.ts'), 'utf8')).toBe(
      'export const ugly = { a: 1, b: 2 };\n',
    )

    const clean = await run(dir)

    expect(clean.result).toBe('ok')
    expect(
      clean.stdout.startsWith(
        `uncheck in ${dir}\n○ sherif skipped, no package.json found\n▶ oxlint\n`,
      ),
    ).toBe(true)
    expect(clean.stdout).toContain('▶ oxlint\n')
    expect(clean.stdout).toContain('▶ oxfmt --check\n')
    expect(clean.stdout).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(clean.stdout).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')
  })

  it('builds referenced projects with tsc -b before checking standalone ones with tsc -p', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'scripts/hello.ts': 'export const greeting = "hi";\n',
      'packages/lib/tsconfig.json': compositeTsconfig(),
      'packages/lib/src/index.ts': 'export const answer: number = 42;\n',
      'packages/app/tsconfig.json': compositeTsconfig(['../lib']),
      'packages/app/src/index.ts':
        'import { answer } from "../../lib/src/index";\n\nexport const double: number = answer * 2;\n',
    })

    const { result, stdout } = await run(dir)

    expect(result).toBe('ok')
    expect(stdout).toContain(
      '▶ tsc -b packages/app/tsconfig.json\n▶ tsc -p tsconfig.json --noEmit\n',
    )
    expect(stdout).not.toContain('packages/lib/tsconfig.json')

    writeFileSync(join(dir, 'packages/lib/src/index.ts'), 'export const answer: number = "42";\n')

    const broken = await run(dir)

    expect(broken.result).toBeInstanceOf(CheckFailed)
    expect((broken.result as CheckFailed).outcomes).toEqual([
      { name: 'sherif', status: 'skipped', reason: 'no package.json found' },
      { name: 'oxlint', status: 'passed' },
      { name: 'oxfmt', status: 'passed' },
      { name: 'tsc', status: 'failed' },
    ])
    expect(broken.stdout).toContain('packages/lib/src/index.ts')
    expect(broken.stdout).toContain('TS2322')
  })

  it('forwards paths to oxlint and oxfmt and narrows tsc to the projects containing them', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'scripts/hello.ts': 'export const greeting = "hi";\n',
      'scripts/legacy.ts': 'var count = 1;\nexport { count };\n',
      'README.md': '# Hi\n',
      'packages/lib/tsconfig.json': compositeTsconfig(),
      'packages/lib/src/index.ts': 'export const answer: number = 42;\n',
      'packages/app/tsconfig.json': compositeTsconfig(['../lib']),
      'packages/app/src/index.ts':
        'import { answer } from "../../lib/src/index";\n\nexport const double: number = answer * 2;\n',
    })

    const scoped = await run(dir, ['packages/app'])

    expect(scoped.result).toBe('ok')
    expect(scoped.stdout).not.toContain('no-var')
    expect(scoped.stdout).toContain(
      '▶ oxlint --no-error-on-unmatched-pattern packages/app/src/index.ts packages/app/tsconfig.json\n',
    )
    expect(scoped.stdout).toContain(
      '▶ oxfmt --check --no-error-on-unmatched-pattern packages/app/src/index.ts packages/app/tsconfig.json\n',
    )
    // The root project's inputs (src, scripts) do not reach into packages/app, so only app is built.
    expect(scoped.stdout).toContain('▶ tsc -b packages/app/tsconfig.json\n✔ tsc')
    expect(scoped.stdout).not.toContain('tsc -p tsconfig.json')

    const single = await run(dir, ['--fix', 'scripts/hello.ts'])

    expect(single.result).toBe('ok')
    expect(single.stdout).toContain(
      '▶ oxlint --fix --no-error-on-unmatched-pattern scripts/hello.ts\n',
    )
    expect(single.stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern scripts/hello.ts\n')
    expect(single.stdout).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(single.stdout).not.toContain('tsc -b')

    const all = await run(dir, ['.'])

    expect(all.stdout).toMatch(/▶ oxlint --no-error-on-unmatched-pattern \[\d+ files\]\n/)
    expect(all.stdout).toMatch(/▶ oxfmt --check --no-error-on-unmatched-pattern \[\d+ files\]\n/)

    const docs = await run(dir, ['README.md'])

    expect(docs.result).toBe('ok')
    expect(docs.stdout).toContain('▶ oxlint --no-error-on-unmatched-pattern README.md\n')
    expect(docs.stdout).toContain('○ tsc skipped, no tsconfig.json covers the given files\n')
    expect(docs.stdout).toContain('✔ all checks passed (oxlint, oxfmt)')
  })

  it('fails on paths that match nothing unless told otherwise', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'src/index.ts': 'export const answer: number = 42;\n',
    })

    await expect(run(dir, ['src/index.ts', 'missing.ts', 'lib/**'])).rejects.toThrow(
      /No files match missing.ts, lib\/\*\*/,
    )

    const lenient = await run(dir, [
      '--no-error-on-unmatched-pattern',
      'src/index.ts',
      'missing.ts',
    ])

    expect(lenient.result).toBe('ok')
    expect(lenient.stdout).toContain('▶ oxlint --no-error-on-unmatched-pattern src/index.ts\n')

    const nothing = await run(dir, ['--no-error-on-unmatched-pattern', 'missing.ts'])

    expect(nothing.result).toBe('ok')
    expect(nothing.stdout).toBe(
      `uncheck in ${dir}\n○ nothing to check, no files match missing.ts\n`,
    )
  })

  it('discovers tsconfig files through git so ignored folders are skipped', async () => {
    const files = {
      '.gitignore': 'node_modules\ndist\nignored\n',
      'tsconfig.json': standaloneTsconfig,
      'src/index.ts': 'export const answer: number = 42;\n',
      'ignored/tsconfig.json': standaloneTsconfig,
      'ignored/src/index.ts': 'export const answer: number = "42";\n',
    }

    const plain = fixture(files, ['typescript'])
    const walked = await run(plain)

    expect(walked.result).toBeInstanceOf(CheckFailed)
    expect(walked.stdout).toContain('▶ tsc -p ignored/tsconfig.json --noEmit\n')

    const repo = fixture(files, ['typescript'])
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    const tracked = await run(repo)

    expect(tracked.result).toBe('ok')
    expect(tracked.stdout).not.toContain('ignored/tsconfig.json')
    expect(tracked.stdout).toContain('○ oxlint skipped, not installed\n')
    expect(tracked.stdout).toContain('○ oxfmt skipped, not installed\n')
  })

  it('fails on circular project references', async () => {
    const dir = fixture(
      {
        'packages/a/tsconfig.json': compositeTsconfig(['../b']),
        'packages/a/src/index.ts': 'export const a = 1;\n',
        'packages/b/tsconfig.json': compositeTsconfig(['../a']),
        'packages/b/src/index.ts': 'export const b = 2;\n',
      },
      ['typescript'],
    )

    const { result, stdout } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect(stdout).toContain(
      '✘ tsc circular project references between packages/a/tsconfig.json, packages/b/tsconfig.json\n',
    )
  })

  it('fails when a tsconfig.json exists but typescript is not installed', async () => {
    const dir = fixture(
      { 'tsconfig.json': standaloneTsconfig, 'src/index.ts': 'export const answer = 42;\n' },
      [],
    )

    const { result, stdout } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect((result as CheckFailed).outcomes.map((outcome) => outcome.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'failed',
    ])
    expect(stdout).toContain('found 1 tsconfig.json but typescript is not installed')
  })

  it('fails when there is nothing to check', async () => {
    const dir = fixture({ 'package.json': '{}\n' }, [])

    const { result, stdout } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect((result as CheckFailed).outcomes.map((outcome) => outcome.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(stdout).toContain(
      'nothing to check: sherif not installed, oxlint not installed, oxfmt not installed, tsc no tsconfig.json found',
    )
  })

  it.skipIf(process.platform === 'win32')(
    'fails a check whose tool is killed and still runs the others',
    async () => {
      const dir = fixture(
        {
          '.oxlintrc.json': oxlintrc,
          'tsconfig.json': standaloneTsconfig,
          'src/index.ts': 'export const answer: number = 42;\n',
          'node_modules/oxlint/package.json': { name: 'oxlint', bin: { oxlint: 'bin.js' } },
          'node_modules/oxlint/bin.js': "process.kill(process.pid, 'SIGKILL')\n",
        },
        ['oxfmt', 'typescript'],
      )

      const { result, stdout } = await run(dir)

      expect(result).toBeInstanceOf(CheckFailed)
      expect(stdout).toContain(
        "▶ oxlint\nProcess interrupted due to receipt of signal: 'SIGKILL'\n",
      )
      expect(stdout).toContain('✘ oxlint failed')
      expect(stdout).toContain('✔ tsc passed')
      expect(stdout).toContain('✘ 1 of 3 checks failed: oxlint')
      expect(stdout).not.toContain('PlatformError')
    },
  )
})

/** A workspace sherif has something to say about, with its install step off so the fix stays offline. */
function workspace(
  extra: Record<string, string | object> = {},
  config: Record<string, unknown> = {},
) {
  return fixture(
    {
      'package.json': {
        name: 'root',
        private: true,
        packageManager: 'pnpm@10.0.0',
        workspaces: ['packages/*'],
        devDependencies: { zod: '^3.0.0', react: '^18.0.0' },
        sherif: { noInstall: true, ...config },
      },
      'packages/a/package.json': {
        name: 'a',
        version: '1.0.0',
        dependencies: { react: '^18.0.0' },
      },
      'packages/b/package.json': {
        name: 'b',
        version: '1.0.0',
        dependencies: { react: '^17.0.0' },
      },
      ...extra,
    },
    ['sherif'],
  )
}

describe('uncheck sherif', { timeout: 120_000 }, () => {
  beforeEach(() => {
    vi.stubEnv('CI', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('checks a workspace root with sherif and fixes it, aligning versions on the highest', async () => {
    const dir = workspace()

    const check = await run(dir)

    expect(check.result).toBeInstanceOf(CheckFailed)
    expect((check.result as CheckFailed).outcomes[0]).toEqual({ name: 'sherif', status: 'failed' })
    expect(check.stdout).toContain('▶ sherif\n')
    expect(check.stdout).toContain('unordered-dependencies')
    expect(check.stdout).toContain('multiple-dependency-versions')
    expect(check.stdout).toContain(
      '✘ 1 of 1 checks failed: sherif\n  rerun with `--fix` to apply sherif fixes',
    )

    const fix = await run(dir, ['--fix'])

    expect(fix.result).toBe('ok')
    expect(fix.stdout).toContain('▶ sherif --fix --select=highest\n')
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).devDependencies),
    ).toEqual(['react', 'zod'])
    expect(JSON.parse(readFileSync(join(dir, 'packages/b/package.json'), 'utf8'))).toMatchObject({
      dependencies: { react: '^18.0.0' },
    })

    const clean = await run(dir)

    expect(clean.result).toBe('ok')
    expect(clean.stdout).toContain('✔ all checks passed (sherif)')
  })

  it('leaves the version choice to the sherif config when it makes one', async () => {
    const dir = workspace({}, { select: 'lowest' })

    const { result, stdout } = await run(dir, ['--fix'])

    expect(result).toBe('ok')
    expect(stdout).toContain('▶ sherif --fix\n')
    expect(JSON.parse(readFileSync(join(dir, 'packages/a/package.json'), 'utf8'))).toMatchObject({
      dependencies: { react: '^17.0.0' },
    })
  })

  it('only checks in CI, where sherif refuses to fix', async () => {
    vi.stubEnv('CI', 'true')

    const dir = workspace()

    const { result, stdout } = await run(dir, ['--fix'])

    expect(result).toBeInstanceOf(CheckFailed)
    expect(stdout).toContain('▶ sherif\n')
    expect(stdout).toContain('unordered-dependencies')
    expect(stdout).not.toContain('Cannot fix issues inside a CI environment')
  })

  it('runs only for a workspace root and only when a package.json is among the given files', async () => {
    const dir = workspace({ 'src/index.ts': 'export const answer = 42;\n' })

    const code = await run(dir, ['src/index.ts'])

    expect(code.result).toBeInstanceOf(CheckFailed)
    expect(code.stdout).toContain('○ sherif skipped, no package.json among the given files\n')
    expect(code.stdout).toContain('nothing to check: sherif no package.json among the given files')

    const manifest = await run(dir, ['packages/a/package.json'])

    expect(manifest.result).toBeInstanceOf(CheckFailed)
    expect(manifest.stdout).toContain('▶ sherif\n')

    const single = fixture({ 'package.json': { name: 'single', private: true } }, ['sherif'])
    const alone = await run(single)

    expect(alone.result).toBeInstanceOf(CheckFailed)
    expect(alone.stdout).toContain('○ sherif skipped, not a workspace root\n')

    const nested = fixture(
      {
        'package.json': { name: 'nested', private: true },
        'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      },
      ['sherif'],
    )
    const pnpm = await run(nested)

    expect(pnpm.stdout).toContain('▶ sherif\n')
  })
})

describe('uncheck check flags', { timeout: 120_000 }, () => {
  it('skips a check with --skip and requires it with --require', async () => {
    const dir = fixture(
      {
        '.oxlintrc.json': oxlintrc,
        'tsconfig.json': standaloneTsconfig,
        'src/index.ts': 'export const answer: string = 1;\n',
      },
      ['oxlint', 'typescript'],
    )

    const skipped = await run(dir, ['--skip=tsc'])

    expect(skipped.result).toBe('ok')
    expect(skipped.stdout).toContain('○ oxfmt skipped, not installed\n')
    expect(skipped.stdout).toContain('○ tsc skipped, disabled with --skip=tsc\n')
    expect(skipped.stdout).toContain('✔ all checks passed (oxlint)')

    const required = await run(dir, ['--require=oxfmt', '--skip=tsc'])

    expect(required.result).toBeInstanceOf(CheckFailed)
    expect(required.stdout).toContain('✘ oxfmt not installed\n')
    expect(required.stdout).toContain('✘ 1 of 2 checks failed: oxfmt')

    await expect(run(dir, ['--require=tsc', '--skip=tsc'])).rejects.toThrow(
      /--require=tsc and --skip=tsc/,
    )

    const none = await run(dir, ['--skip=oxlint', '--skip=oxfmt', '--skip=tsc'])

    expect(none.result).toBeInstanceOf(CheckFailed)
    expect(none.stdout).toContain(
      'nothing to check: sherif not installed, oxlint disabled with --skip=oxlint, oxfmt disabled with --skip=oxfmt, tsc disabled with --skip=tsc',
    )
  })

  it('runs only the checks named with --only', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'src/ugly.ts': 'export const   ugly = 1\n',
    })

    const lint = await run(dir, ['--only=oxlint'])

    expect(lint.result).toBe('ok')
    expect(lint.stdout).toContain('▶ oxlint\n')
    expect(lint.stdout).toContain('○ oxfmt skipped, not selected by --only\n')
    expect(lint.stdout).toContain('○ tsc skipped, not selected by --only\n')
    expect(lint.stdout).toContain('✔ all checks passed (oxlint)')

    const format = await run(dir, ['--only=oxfmt'])

    expect(format.result).toBeInstanceOf(CheckFailed)
    expect((format.result as CheckFailed).outcomes).toEqual([
      { name: 'sherif', status: 'skipped', reason: 'not selected by --only' },
      { name: 'oxlint', status: 'skipped', reason: 'not selected by --only' },
      { name: 'oxfmt', status: 'failed' },
      { name: 'tsc', status: 'skipped', reason: 'not selected by --only' },
    ])

    await expect(run(dir, ['--only=oxlint', '--skip=oxlint'])).rejects.toThrow(
      /--only=oxlint and --skip=oxlint/,
    )
    await expect(run(dir, ['--only=oxlint', '--only=oxfmt', '--require=tsc'])).rejects.toThrow(
      /--require=tsc and --only=oxlint --only=oxfmt/,
    )
  })
})

describe('uncheck hooks install', { timeout: 120_000 }, () => {
  it('writes stop hook configs for the named agents through the detected package manager', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])

    const { result, stdout } = await run(dir, ['hooks', 'install', 'claude', 'cursor', 'copilot'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ Claude Code .claude/settings.json created\n')
    expect(stdout).toContain('✔ Cursor .cursor/hooks.json created\n')
    expect(stdout).toContain('pnpm exec uncheck hooks run --fix')

    const hook = 'pnpm exec uncheck hooks run --fix'

    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, timeout: 600 }] }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.cursor/hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: hook, timeout: 600 }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.github/hooks/uncheck.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: {
        agentStop: [{ type: 'command', bash: hook, powershell: hook, timeoutSec: 600 }],
      },
    })

    const again = await run(dir, ['hooks', 'install', 'claude'])

    expect(again.result).toBe('ok')
    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')
  })

  it('merges into existing settings and keeps other hooks', async () => {
    const dir = fixture(
      {
        'package.json': '{}\n',
        '.claude/settings.json': `{
  // keep me
  "permissions": { "allow": ["Bash(pnpm test)"] },
  "hooks": { "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo done" }] }] },
}
`,
      },
      [],
    )

    const { result, stdout } = await run(dir, ['hooks', 'install', 'codebuddy', 'claude'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(stdout).toContain('✔ CodeBuddy .codebuddy/settings.json created\n')
    expect(stdout).toContain('npx --no uncheck hooks run --fix')

    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo done' }] }],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'npx --no uncheck hooks run --fix', timeout: 600 }],
          },
        ],
      },
    })
  })

  it('rejects unknown agents', async () => {
    const dir = fixture({ 'package.json': '{}\n' }, [])

    await expect(run(dir, ['hooks', 'install', 'emacs'])).rejects.toThrow()
  })

  it('writes the check flags into the hook command and updates an installed hook', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'yarn.lock': '' }, [])
    const fast = 'yarn run --silent uncheck hooks run --fix --only=oxlint --only=oxfmt'

    const { result, stdout } = await run(dir, [
      'hooks',
      'install',
      'claude',
      'copilot',
      '--only=oxlint',
      '--only=oxfmt',
    ])

    expect(result).toBe('ok')
    expect(stdout).toContain(fast)
    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: fast, timeout: 600 }] }] },
    })

    const all = 'yarn run --silent uncheck hooks run --fix'
    const again = await run(dir, ['hooks', 'install', 'claude', 'copilot'])

    expect(again.result).toBe('ok')
    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(again.stdout).toContain('✔ GitHub Copilot .github/hooks/uncheck.json updated\n')
    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: all, timeout: 600 }] }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.github/hooks/uncheck.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: {
        agentStop: [{ type: 'command', bash: all, powershell: all, timeoutSec: 600 }],
      },
    })

    await expect(
      run(dir, ['hooks', 'install', 'claude', '--only=oxlint', '--skip=oxlint']),
    ).rejects.toThrow(/--only=oxlint and --skip=oxlint/)
  })

  it('updates its own entry in place and leaves strings that only mention the hook alone', async () => {
    const mentions = {
      _comment: 'the Stop hook runs npx uncheck hooks run --fix',
      permissions: { allow: ['Bash(npx uncheck hooks run:*)'] },
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'cd packages/web && npx uncheck hooks run --fix && notify',
              },
            ],
          },
        ],
      },
    }
    const dir = fixture({ 'package.json': '{}\n', '.claude/settings.json': mentions }, [])
    const hook = { type: 'command', command: 'npx --no uncheck hooks run --fix', timeout: 600 }

    const { result, stdout } = await run(dir, ['hooks', 'install', 'claude'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      ...mentions,
      hooks: { ...mentions.hooks, Stop: [{ hooks: [hook] }] },
    })

    const older = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'npx uncheck hooks run --fix --only=oxlint',
                statusMessage: 'Checking',
              },
            ],
          },
        ],
      },
    }

    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(older))

    const upgraded = await run(dir, ['hooks', 'install', 'claude'])

    expect(upgraded.stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ ...hook, statusMessage: 'Checking' }] }] },
    })

    const again = await run(dir, ['hooks', 'install', 'claude'])

    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')
  })

  it('refuses a config that is not a JSON object and leaves every file as it is', async () => {
    const broken = '{\n  permissions: { "deny": ["Read(.env)"] },\n  "model": "opus"\n}\n'
    const dir = fixture(
      { 'package.json': '{}\n', '.cursor/hooks.json': broken, '.github/hooks/uncheck.json': '[]' },
      [],
    )

    await expect(run(dir, ['hooks', 'install', 'claude', 'cursor'])).rejects.toThrow(
      '.cursor/hooks.json has InvalidSymbol on line 2, fix it and run again',
    )
    await expect(run(dir, ['hooks', 'install', 'copilot'])).rejects.toThrow(
      '.github/hooks/uncheck.json is not a JSON object',
    )
    expect(readFileSync(join(dir, '.cursor/hooks.json'), 'utf8')).toBe(broken)
    expect(readFileSync(join(dir, '.github/hooks/uncheck.json'), 'utf8')).toBe('[]')
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false)

    writeFileSync(join(dir, '.cursor/hooks.json'), '\n')

    const { result, stdout } = await run(dir, ['hooks', 'install', 'cursor'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ Cursor .cursor/hooks.json updated\n')
  })

  it('names the directory below the top of the repository in the hook command', async () => {
    const dir = committed({ 'package.json': '{}\n', 'packages/web/package.json': '{}\n' })
    mkdirSync(join(dir, 'packages/my web'))

    const { result, stdout } = await run(join(dir, 'packages/web'), ['hooks', 'install', 'claude'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ Claude Code .claude/settings.json created\n')
    expect(
      JSON.parse(readFileSync(join(dir, 'packages/web/.claude/settings.json'), 'utf8')),
    ).toMatchObject({
      hooks: {
        Stop: [{ hooks: [{ command: 'npx --no uncheck hooks run --fix --dir=packages/web' }] }],
      },
    })

    const again = await run(join(dir, 'packages/web'), ['hooks', 'install', 'claude'])

    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')
    await expect(run(join(dir, 'packages/my web'), ['hooks', 'install', 'claude'])).rejects.toThrow(
      /cannot name packages\/my web/,
    )
  })
})

/** Runs git in `dir` with a throwaway identity and returns what it printed. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=uncheck', '-c', 'user.email=uncheck@example.com', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  )
}

/** A git repository with one clean commit, so later edits show up as working-tree changes. */
function committed(files: Record<string, string | object>) {
  const dir = fixture(files)

  gitIn(dir, 'init', '--quiet')
  gitIn(dir, 'add', '.')
  gitIn(dir, 'commit', '--quiet', '-m', 'init')

  return dir
}

const clean = {
  '.oxlintrc.json': oxlintrc,
  'tsconfig.json': standaloneTsconfig,
  'src/index.ts': 'export const answer: number = 42;\n',
  'src/other.ts': 'export const other = 2;\n',
}

function installPreCommitHook(dir: string, args: string, folder = '.') {
  const bin = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))

  mkdirSync(join(dir, '.git/hooks'), { recursive: true })
  writeFileSync(
    join(dir, '.git/hooks/pre-commit'),
    `#!/bin/sh\n(cd "${folder}" && "${process.execPath}" "${bin}" ${args}) || exit 1\n`,
    { mode: 0o755 },
  )
}

describe('uncheck hooks run', { timeout: 120_000 }, () => {
  it('checks the files changed since the last commit and sends the agent back once', async () => {
    const dir = committed(clean)
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: string = 1\n')
    writeFileSync(join(dir, 'src/fresh.ts'), 'export const fresh = 3;\n')

    const claude = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    )

    expect(claude.result).toBe('blocked')
    expect(claude.stdout).toBe('')
    expect(claude.stderr).toContain(
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/fresh.ts src/index.ts\n',
    )
    expect(claude.stderr).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(claude.stderr).toContain('TS2322')
    expect(claude.stderr).toContain('✘ 1 of 3 checks failed: tsc')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const answer: string = 1;\n',
    )

    const continuing = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }),
    )

    expect(continuing.result).toBe('ok')
    expect(JSON.parse(continuing.stdout)).toEqual({
      systemMessage: 'uncheck still fails: 1 of 3 checks failed: tsc',
    })
    expect(continuing.stderr).toContain('TS2322')

    const cursor = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'stop', loop_count: 0 }),
    )

    expect(cursor.result).toBe('ok')
    expect((JSON.parse(cursor.stdout) as { followup_message: string }).followup_message).toContain(
      'TS2322',
    )

    const copilot = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ stopReason: 'end_turn', stop_hook_active: false }),
    )

    expect(copilot.result).toBe('ok')
    expect(JSON.parse(copilot.stdout)).toMatchObject({ decision: 'block' })

    const copilotInClaudeFormat = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'Stop', stop_reason: 'end_turn', stop_hook_active: false }),
    )

    expect(copilotInClaudeFormat.result).toBe('ok')
    expect(JSON.parse(copilotInClaudeFormat.stdout)).toMatchObject({ decision: 'block' })
  })

  it('passes a change no selected check covers, unless that check is required', async () => {
    const dir = committed(clean)
    writeFileSync(join(dir, 'README.md'), '# Project\n')

    const optional = await run(
      dir,
      ['hooks', 'run', '--fix', '--only=tsc'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    )

    expect(optional.result).toBe('ok')
    expect(optional.stderr).toContain('○ nothing to check')

    const required = await run(
      dir,
      ['hooks', 'run', '--fix', '--only=tsc', '--require=tsc'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    )

    expect(required.result).toBe('blocked')
  })

  it('never takes a deleted file for a pattern that matches its neighbours', async () => {
    const dir = committed({
      ...clean,
      'app/[id].ts': 'export const id = 1;\n',
      'app/i.ts': 'export const   i = 1\n',
    })
    rmSync(join(dir, 'app/[id].ts'))

    const { result, stderr } = await run(
      dir,
      ['hooks', 'run', '--fix', '--only=oxfmt'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    )

    expect(result).toBe('ok')
    expect(stderr).not.toContain('app/i.ts')
    expect(readFileSync(join(dir, 'app/i.ts'), 'utf8')).toBe('export const   i = 1\n')
  })

  it('checks the top of the repository wherever the agent moved to, or the directory in --dir', async () => {
    const dir = committed({
      ...clean,
      'docs/guide.md': '# Guide\n',
      'packages/app/src/index.ts': 'export const app = 1;\n',
      'packages/web/src/index.ts': 'export const web = 1;\n',
    })
    writeFileSync(join(dir, 'src/index.ts'), 'export const answer: string = 1;\n')

    const bin = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))
    const moved = spawnSync(process.execPath, [bin, 'hooks', 'run', '--fix'], {
      cwd: join(dir, 'docs'),
      input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8',
    })

    expect(moved.status).toBe(2)
    expect(moved.stderr).toContain('TS2322')

    writeFileSync(join(dir, 'packages/app/src/index.ts'), 'export const   app = 2\n')
    writeFileSync(join(dir, 'packages/web/src/index.ts'), 'export const   web = 2\n')

    const { result, stderr } = await run(
      join(dir, 'packages/web'),
      ['hooks', 'run', '--fix', '--only=oxfmt', '--dir=packages/app'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    )

    expect(result).toBe('ok')
    expect(stderr).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/index.ts\n')
    expect(readFileSync(join(dir, 'packages/app/src/index.ts'), 'utf8')).toBe(
      'export const app = 2;\n',
    )
    expect(readFileSync(join(dir, 'packages/web/src/index.ts'), 'utf8')).toBe(
      'export const   web = 2\n',
    )
  })

  it('stays silent when nothing changed and passes quietly when the changes are clean', async () => {
    const dir = committed(clean)

    const nothing = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'Stop' }),
    )

    expect(nothing.result).toBe('ok')
    expect(nothing.stdout).toBe('')
    expect(nothing.stderr).toBe('')

    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')

    const ok = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'Stop' }),
    )

    expect(ok.result).toBe('ok')
    expect(ok.stdout).toBe('')
    expect(ok.stderr).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern src/other.ts\n')
    expect(ok.stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')

    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: string = 1\n')

    const fast = await run(
      dir,
      ['hooks', 'run', '--fix', '--only=oxlint', '--only=oxfmt'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    )

    expect(fast.result).toBe('ok')
    expect(fast.stdout).toBe('')
    expect(fast.stderr).toContain('○ tsc skipped, not selected by --only\n')
    expect(fast.stderr).toContain('✔ all checks passed (oxlint, oxfmt)')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const answer: string = 1;\n',
    )
  })

  it('checks everything under the directory outside a git repository', async () => {
    const dir = fixture(clean)

    const { result, stderr } = await run(dir, ['hooks', 'run'], '{}')

    expect(result).toBe('ok')
    expect(stderr).toContain('▶ oxlint\n')
    expect(stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')
  })
})

describe('uncheck staged', { timeout: 120_000 }, () => {
  it('checks the staged files, stages the fixes and keeps unstaged changes out of the way', async () => {
    const dir = committed(clean)

    writeFileSync(
      join(dir, 'src/index.ts'),
      'export const   answer: number = 42\nexport const two = 2;\n',
    )
    gitIn(dir, 'add', 'src/index.ts')
    // An unstaged hunk in the staged file, an unstaged file and an untracked one: none of them is checked.
    writeFileSync(
      join(dir, 'src/index.ts'),
      'export const   answer: number = 42\nexport const two = 2;\nexport const three = 3;\n',
    )
    writeFileSync(join(dir, 'src/other.ts'), 'export const   other = 3\n')
    writeFileSync(join(dir, 'src/fresh.ts'), 'var fresh = 4\n')

    const { result, stdout } = await run(dir, ['staged', '--fix'])

    expect(result).toBe('ok')
    expect(stdout).toContain(
      `uncheck staged in ${dir}\n○ unstaged changes of src/index.ts set aside until the checks finish\n`,
    )
    expect(stdout).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts\n')
    expect(stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/index.ts\n')
    expect(stdout).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(stdout).toContain('✔ all checks passed (oxlint, oxfmt, tsc)\n')
    expect(stdout).toContain(
      '✔ staged the fixes to src/index.ts\n○ unstaged changes of src/index.ts restored\n',
    )
    expect(gitIn(dir, 'show', ':src/index.ts')).toBe(
      'export const answer: number = 42;\nexport const two = 2;\n',
    )
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const answer: number = 42;\nexport const two = 2;\nexport const three = 3;\n',
    )
    expect(readFileSync(join(dir, 'src/other.ts'), 'utf8')).toBe('export const   other = 3\n')
    expect(readFileSync(join(dir, 'src/fresh.ts'), 'utf8')).toBe('var fresh = 4\n')
    expect(gitIn(dir, 'status', '--porcelain')).toBe(
      'MM src/index.ts\n M src/other.ts\n?? src/fresh.ts\n',
    )
    expect(existsSync(join(dir, '.git/uncheck-unstaged'))).toBe(false)
  })

  it('undoes the fixes when they conflict with unstaged changes, so nothing is lost', async () => {
    const dir = committed(clean)

    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 42\n')
    gitIn(dir, 'add', 'src/index.ts')
    // The unstaged change touches the line the formatter rewrites.
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 43\n')
    writeFileSync(join(dir, 'src/other.ts'), 'export const   other = 2\n')
    gitIn(dir, 'add', 'src/other.ts')

    await expect(run(dir, ['staged', '--fix'])).rejects.toThrow(
      /fixes conflict with the unstaged changes of src\/index\.ts and were undone/,
    )

    expect(gitIn(dir, 'show', ':src/index.ts')).toBe('export const   answer: number = 42\n')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const   answer: number = 43\n',
    )
    // The fixes to the other staged file are undone too, so a commit attempt never half applies.
    expect(gitIn(dir, 'show', ':src/other.ts')).toBe('export const   other = 2\n')
    expect(readFileSync(join(dir, 'src/other.ts'), 'utf8')).toBe('export const   other = 2\n')
    expect(existsSync(join(dir, '.git/uncheck-unstaged'))).toBe(false)
  })

  it('fails when the fixes undo every staged change, unless empty commits are allowed', async () => {
    const dir = committed({
      ...clean,
      'src/index.ts': 'export const answer: number = 42;\nexport const two = 2;\n',
    })

    writeFileSync(
      join(dir, 'src/index.ts'),
      'export const   answer: number = 42\nexport const two = 2;\n',
    )
    gitIn(dir, 'add', 'src/index.ts')
    writeFileSync(
      join(dir, 'src/index.ts'),
      'export const   answer: number = 42\nexport const two = 2;\nexport const three = 3;\n',
    )

    await expect(run(dir, ['staged', '--fix'])).rejects.toThrow(
      /fixes undid every staged change, so the commit would be empty/,
    )

    expect(gitIn(dir, 'diff', '--cached', '--name-only')).toBe('')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const answer: number = 42;\nexport const two = 2;\nexport const three = 3;\n',
    )
    expect(existsSync(join(dir, '.git/uncheck-unstaged'))).toBe(false)

    writeFileSync(join(dir, 'src/other.ts'), 'export const   other = 2\n')
    gitIn(dir, 'add', 'src/other.ts')

    const allowed = await run(dir, ['staged', '--fix', '--allow-empty'])

    expect(allowed.result).toBe('ok')
    expect(allowed.stdout).toContain('✔ staged the fixes to src/other.ts\n')
    expect(gitIn(dir, 'diff', '--cached', '--name-only')).toBe('')

    const unborn = fixture(clean)

    gitIn(unborn, 'init', '--quiet')
    gitIn(unborn, 'add', '.')

    expect((await run(unborn, ['staged', '--fix'])).result).toBe('ok')
  })

  it('lets a merge through when the fixes turn its tree back into what HEAD has', async () => {
    const dir = committed(clean)

    gitIn(dir, 'checkout', '--quiet', '-b', 'side')
    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')
    gitIn(dir, 'commit', '--quiet', '-am', 'side')
    gitIn(dir, 'checkout', '--quiet', '-')
    gitIn(dir, 'merge', '--quiet', '--no-commit', '--no-ff', 'side')
    writeFileSync(join(dir, 'src/other.ts'), 'export const   other = 2\n')
    gitIn(dir, 'add', 'src/other.ts')

    const { result, stdout } = await run(dir, ['staged', '--fix'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ staged the fixes to src/other.ts\n')
    expect(gitIn(dir, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('only reports without --fix, stages the fixes even when a check fails, and needs staged files', async () => {
    const dir = committed(clean)

    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: string = 1\n')
    gitIn(dir, 'add', 'src/index.ts')

    const check = await run(dir, ['staged'])

    expect(check.result).toBeInstanceOf(CheckFailed)
    expect((check.result as CheckFailed).outcomes).toEqual([
      { name: 'sherif', status: 'skipped', reason: 'no package.json among the given files' },
      { name: 'oxlint', status: 'passed' },
      { name: 'oxfmt', status: 'failed' },
      { name: 'tsc', status: 'failed' },
    ])
    expect(check.stdout).toContain('▶ oxfmt --check --no-error-on-unmatched-pattern src/index.ts\n')
    expect(check.stdout).not.toContain('staged the fixes')
    expect(gitIn(dir, 'show', ':src/index.ts')).toBe('export const   answer: string = 1\n')

    const fix = await run(dir, ['staged', '--fix'])

    expect(fix.result).toBeInstanceOf(CheckFailed)
    expect(fix.stdout).toContain('TS2322')
    expect(fix.stdout).toContain('✔ staged the fixes to src/index.ts\n')
    expect(gitIn(dir, 'show', ':src/index.ts')).toBe('export const answer: string = 1;\n')
    expect(gitIn(dir, 'status', '--porcelain')).toBe('M  src/index.ts\n')

    gitIn(dir, 'commit', '--quiet', '-m', 'wip')

    const nothing = await run(dir, ['staged', '--fix'])

    expect(nothing.result).toBe('ok')
    expect(nothing.stdout).toBe(`uncheck staged in ${dir}\n○ nothing to check, no staged files\n`)

    await expect(run(fixture(clean), ['staged'])).rejects.toThrow(/needs a git repository/)
  })

  it('puts unstaged lines back where they were after the fixes move or change lines around them', async () => {
    const split = 'export const list = [\n  1,\n  2,\n];\n'
    const joined = 'export const list = [1, 2];\n'
    const staged =
      "\nexport function f() {\n  return 1;\n}\n\nexport function g() {\n  return 'g'\n}\n"
    const fixed = staged.replace("'g'", '"g";')
    const edit = (text: string) =>
      `${text.replace('  return 1;', '  // in f\n  return 1;')}\nexport const z = 1;\n`
    const dir = committed({ 'packages/app/src/index.ts': joined })
    const file = join(dir, 'packages/app/src/index.ts')

    writeFileSync(file, split + staged)
    gitIn(dir, 'add', '.')
    writeFileSync(file, split + edit(staged))

    const { result } = await run(join(dir, 'packages/app'), ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(gitIn(dir, 'show', ':packages/app/src/index.ts')).toBe(joined + fixed)
    expect(readFileSync(file, 'utf8')).toBe(joined + edit(fixed))
  })

  it('stages only the staged files, even when their names look like patterns', async () => {
    const dir = committed({
      'app/[id]/page.ts': 'export const id = 1;\n',
      'app/i/page.ts': 'export const i = 1;\n',
    })

    writeFileSync(join(dir, 'app/[id]/page.ts'), 'export const   id = 2\n')
    writeFileSync(join(dir, 'app/i/page.ts'), 'export const   i = 2\n')
    gitIn(dir, '--literal-pathspecs', 'add', 'app/[id]/page.ts')
    vi.stubEnv('GIT_GLOB_PATHSPECS', '1')
    vi.stubEnv('GIT_ICASE_PATHSPECS', '1')

    const { result } = await run(dir, ['staged', '--fix', '--only=oxfmt']).finally(() =>
      vi.unstubAllEnvs(),
    )

    expect(result).toBe('ok')
    expect(gitIn(dir, 'status', '--porcelain')).toBe('M  app/[id]/page.ts\n M app/i/page.ts\n')
  })

  it('never stages the commit a submodule has checked out but not staged', async () => {
    const dir = committed(clean)
    const sub = join(dir, 'sub')

    mkdirSync(sub)
    gitIn(sub, 'init', '--quiet')
    gitIn(sub, 'commit', '--quiet', '--allow-empty', '-m', 'one')
    gitIn(dir, 'add', 'sub')
    gitIn(sub, 'commit', '--quiet', '--allow-empty', '-m', 'two')
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 43\n')
    gitIn(dir, 'add', 'sub', 'src/index.ts')
    gitIn(sub, 'commit', '--quiet', '--allow-empty', '-m', 'three')
    const staged = gitIn(dir, 'rev-parse', ':sub')

    const { result } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(gitIn(dir, 'rev-parse', ':sub')).toBe(staged)
  })

  it('merges what git stores, so line endings a formatter rewrites are no change', async () => {
    const dir = committed(clean)
    const crlf = (text: string) => text.replaceAll('\n', '\r\n')
    const lines = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n'

    gitIn(dir, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(dir, 'src/index.ts'), crlf(`export const   answer: number = 43\n${lines}`))
    gitIn(dir, 'add', 'src/index.ts')
    writeFileSync(
      join(dir, 'src/index.ts'),
      crlf(`export const   answer: number = 43\n${lines}export const d = 4;\n`),
    )

    const { result } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(gitIn(dir, 'show', ':src/index.ts')).toBe(`export const answer: number = 43;\n${lines}`)
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      crlf(`export const answer: number = 43;\n${lines}export const d = 4;\n`),
    )
  })

  it('reads every unstaged change right, a rename among them', async () => {
    const dir = committed({ ...clean, 'src/aaa.ts': 'export const aaa = 1;\n' })

    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')
    gitIn(dir, 'add', 'src/other.ts')
    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\nexport const more = 4;\n')
    gitIn(dir, 'mv', 'src/aaa.ts', 'src/moved.ts')
    gitIn(dir, 'reset', '--quiet', '--', 'src/aaa.ts', 'src/moved.ts')
    gitIn(dir, 'add', '--intent-to-add', 'src/moved.ts')

    const { result } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(gitIn(dir, 'show', ':src/other.ts')).toBe('export const other = 3;\n')
    expect(readFileSync(join(dir, 'src/other.ts'), 'utf8')).toBe(
      'export const other = 3;\nexport const more = 4;\n',
    )
  })

  it('merges by plain text whatever merge driver the repository sets', async () => {
    const dir = committed(clean)
    const lines = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n'

    mkdirSync(join(dir, '.git/info'), { recursive: true })
    writeFileSync(join(dir, '.git/info/attributes'), '*.ts merge=ours\n')
    gitIn(dir, 'config', 'merge.ours.driver', 'true')
    writeFileSync(join(dir, 'src/index.ts'), `export const   answer: number = 42\n${lines}`)
    gitIn(dir, 'add', 'src/index.ts')
    writeFileSync(
      join(dir, 'src/index.ts'),
      `export const   answer: number = 42\n${lines.replace('c = 3', 'c = 30')}`,
    )

    const { result } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      `export const answer: number = 42;\n${lines.replace('c = 3', 'c = 30')}`,
    )
  })

  it('refuses to set aside an unstaged change that is not an edit to a file', async () => {
    const dir = committed(clean)

    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')
    gitIn(dir, 'add', 'src/other.ts')
    rmSync(join(dir, 'src/other.ts'))

    await expect(run(dir, ['staged', '--fix'])).rejects.toThrow(
      /src\/other\.ts are not edits to a file/,
    )
    expect(existsSync(join(dir, 'src/other.ts'))).toBe(false)
    expect(gitIn(dir, 'show', ':src/other.ts')).toBe('export const other = 3;\n')
  })

  it('keeps the unstaged changes when setting them aside fails halfway', async () => {
    const dir = committed(clean)

    mkdirSync(join(dir, '.git/info'), { recursive: true })
    writeFileSync(join(dir, '.git/info/attributes'), 'src/other.ts filter=flaky\n')
    gitIn(dir, 'config', 'filter.flaky.clean', 'cat')
    gitIn(
      dir,
      'config',
      'filter.flaky.smudge',
      'if [ -e .git/failed ]; then cat; else touch .git/failed; exit 1; fi',
    )
    gitIn(dir, 'config', 'filter.flaky.required', 'true')
    writeFileSync(join(dir, 'src/index.ts'), 'export const answer: number = 43;\n')
    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')
    gitIn(dir, 'add', 'src')
    writeFileSync(join(dir, 'src/index.ts'), 'export const answer: number = 44;\n')
    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 4;\n')

    await expect(run(dir, ['staged'])).rejects.toThrow(/git checkout-index -f \[2 paths\] failed/)

    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const answer: number = 44;\n',
    )
    expect(readFileSync(join(dir, 'src/other.ts'), 'utf8')).toBe('export const other = 4;\n')
    expect(gitIn(dir, 'status', '--porcelain')).toBe('MM src/index.ts\nMM src/other.ts\n')
    expect(existsSync(join(dir, '.git/uncheck-unstaged'))).toBe(false)
  })

  it('stages the fixes in the index `git commit <paths>` leaves behind, not only in its own', () => {
    const dir = committed(clean)

    installPreCommitHook(dir, 'staged --fix --only=oxfmt')
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 43\n')
    gitIn(dir, 'commit', '--quiet', '-m', 'fix', 'src/index.ts')

    expect(gitIn(dir, 'show', 'HEAD:src/index.ts')).toBe('export const answer: number = 43;\n')
    expect(gitIn(dir, 'status', '--porcelain')).toBe('')
  })

  it('runs from a package folder of a linked worktree, whose hook git hands GIT_DIR', () => {
    const dir = committed({
      ...clean,
      '.gitignore': 'node_modules\nworktrees\n',
      'packages/app/src/index.ts': 'export const app = 1;\n',
    })
    const worktree = join(dir, 'worktrees/wt')

    installPreCommitHook(dir, 'staged --fix --only=oxfmt', 'packages/app')
    gitIn(dir, 'worktree', 'add', '--quiet', worktree)
    symlinkSync(join(dir, 'node_modules'), join(worktree, 'node_modules'))
    writeFileSync(join(worktree, 'packages/app/src/index.ts'), 'export const   app = 2\n')
    gitIn(worktree, 'commit', '--quiet', '-am', 'fix')

    expect(gitIn(worktree, 'show', 'HEAD:packages/app/src/index.ts')).toBe(
      'export const app = 2;\n',
    )
    expect(gitIn(worktree, 'status', '--porcelain')).toBe('')
  })

  it('stops instead of overwriting unstaged changes an earlier run left behind', async () => {
    const dir = committed(clean)

    writeFileSync(join(dir, 'src/index.ts'), 'export const answer: number = 43;\n')
    gitIn(dir, 'add', 'src/index.ts')
    writeFileSync(join(dir, 'src/index.ts'), 'export const answer: number = 44;\n')
    mkdirSync(join(dir, '.git/uncheck-unstaged/src'), { recursive: true })
    writeFileSync(join(dir, '.git/uncheck-unstaged/src/index.ts'), 'left behind')

    await expect(run(dir, ['staged', '--fix'])).rejects.toThrow(
      /An earlier run left the unstaged versions of your files in .*uncheck-unstaged/,
    )
    expect(readFileSync(join(dir, '.git/uncheck-unstaged/src/index.ts'), 'utf8')).toBe(
      'left behind',
    )
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const answer: number = 44;\n',
    )
  })

  it.skipIf(process.platform === 'win32')(
    'checks a symlink turned into a file, never what a staged symlink points to',
    async () => {
      const dir = committed(clean)

      symlinkSync('other.ts', join(dir, 'src/link.ts'))
      gitIn(dir, 'add', 'src/link.ts')
      gitIn(dir, 'commit', '--quiet', '-m', 'link')
      rmSync(join(dir, 'src/link.ts'))
      writeFileSync(join(dir, 'src/link.ts'), 'export const   link = 1\n')
      symlinkSync('other.ts', join(dir, 'src/alias.ts'))
      gitIn(dir, 'add', 'src/link.ts', 'src/alias.ts')
      writeFileSync(join(dir, 'src/other.ts'), 'export const   other = 3\n')

      const { result, stdout } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

      expect(result).toBe('ok')
      expect(stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/link.ts\n')
      expect(stdout).toContain('✔ staged the fixes to src/link.ts\n')
      expect(gitIn(dir, 'show', ':src/link.ts')).toBe('export const link = 1;\n')
      expect(readFileSync(join(dir, 'src/other.ts'), 'utf8')).toBe('export const   other = 3\n')
      expect(gitIn(dir, 'status', '--porcelain')).toBe(
        'A  src/alias.ts\nT  src/link.ts\n M src/other.ts\n',
      )
    },
  )

  it('checks only the files of a merge that differ from the side merged in', async () => {
    const dir = committed(clean)

    gitIn(dir, 'checkout', '--quiet', '-b', 'side')
    writeFileSync(join(dir, 'src/theirs.ts'), 'export const   theirs = 1\n')
    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')
    gitIn(dir, 'add', 'src')
    gitIn(dir, 'commit', '--quiet', '-m', 'side')
    gitIn(dir, 'checkout', '--quiet', '-')
    gitIn(dir, 'merge', '--quiet', '--no-commit', '--no-ff', 'side')
    writeFileSync(join(dir, 'src/other.ts'), 'export const   other = 4\n')
    gitIn(dir, 'add', 'src/other.ts')

    const { result, stdout } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/other.ts\n')
    expect(gitIn(dir, 'show', ':src/other.ts')).toBe('export const other = 4;\n')
    expect(gitIn(dir, 'show', ':src/theirs.ts')).toBe('export const   theirs = 1\n')
  })

  it('undoes or stages only what the fixes changed, so a merge can bring in files outside a sparse checkout', async () => {
    const dir = committed({ ...clean, 'lib/lib.ts': 'export const lib = 1;\n' })

    gitIn(dir, 'checkout', '--quiet', '-b', 'side')
    writeFileSync(join(dir, 'lib/lib.ts'), 'export const lib = 2;\n')
    gitIn(dir, 'commit', '--quiet', '-am', 'side')
    gitIn(dir, 'checkout', '--quiet', '-')
    gitIn(dir, 'sparse-checkout', 'set', 'src')
    gitIn(dir, 'merge', '--quiet', '--squash', 'side')
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 42\n')
    gitIn(dir, 'add', 'src/index.ts')
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 43\n')

    await expect(run(dir, ['staged', '--fix', '--only=oxfmt'])).rejects.toThrow(
      /fixes conflict with the unstaged changes of src\/index\.ts and were undone/,
    )
    expect(gitIn(dir, 'status', '--porcelain')).toBe('M  lib/lib.ts\nMM src/index.ts\n')

    gitIn(dir, 'add', 'src/index.ts')

    const { result, stdout } = await run(dir, ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ staged the fixes to src/index.ts\n')
    expect(existsSync(join(dir, 'lib'))).toBe(false)
    expect(gitIn(dir, 'show', ':lib/lib.ts')).toBe('export const lib = 2;\n')
    expect(gitIn(dir, 'show', ':src/index.ts')).toBe('export const answer: number = 43;\n')
  })

  it('sees no change in a file git keeps with CRLF line endings under text=auto', async () => {
    const lines = 'export const a = 1;\r\nexport const b = 2;\r\n'
    const dir = committed({ ...clean, 'src/legacy.ts': lines })
    const file = join(dir, 'src/legacy.ts')

    writeFileSync(join(dir, '.gitattributes'), '* text=auto\n')
    gitIn(dir, 'add', '.gitattributes')
    gitIn(dir, 'commit', '--quiet', '-m', 'attributes')
    writeFileSync(file, `${lines}export const c = 3;\r\n`)
    gitIn(dir, 'add', 'src/legacy.ts')
    writeFileSync(file, `${lines}export const c = 3;\r\nexport const d = 4;\r\n`)

    const { result } = await run(dir, ['staged', '--only=oxlint'])

    expect(result).toBe('ok')
    expect(readFileSync(file, 'utf8')).toBe(
      `${lines}export const c = 3;\r\nexport const d = 4;\r\n`,
    )
    expect(gitIn(dir, 'status', '--porcelain')).toBe('MM src/legacy.ts\n')
  })

  it('sets unstaged changes aside and back without running the post-checkout hook', async () => {
    const dir = committed(clean)

    mkdirSync(join(dir, '.git/hooks'), { recursive: true })
    writeFileSync(
      join(dir, '.git/hooks/post-checkout'),
      '#!/bin/sh\ntouch .git/post-checkout-ran\nexit 1\n',
      { mode: 0o755 },
    )
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 42\n')
    gitIn(dir, 'add', 'src/index.ts')
    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 43\n')

    await expect(run(dir, ['staged', '--fix', '--only=oxfmt'])).rejects.toThrow(
      /fixes conflict with the unstaged changes of src\/index\.ts and were undone/,
    )

    expect(existsSync(join(dir, '.git/post-checkout-ran'))).toBe(false)
    expect(gitIn(dir, 'show', ':src/index.ts')).toBe('export const   answer: number = 42\n')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      'export const   answer: number = 43\n',
    )
  })

  it('only reports what sherif finds, since its fixes reach beyond the staged files', async () => {
    const dir = workspace()

    gitIn(dir, 'init', '--quiet')
    gitIn(dir, 'add', '.')
    gitIn(dir, 'commit', '--quiet', '-m', 'init')
    writeFileSync(
      join(dir, 'packages/a/package.json'),
      JSON.stringify({ name: 'a', version: '1.0.1', dependencies: { react: '^18.0.0' } }),
    )
    gitIn(dir, 'add', 'packages/a/package.json')
    vi.stubEnv('CI', undefined)

    const { result, stdout } = await run(dir, ['staged', '--fix']).finally(() => vi.unstubAllEnvs())

    expect(result).toBeInstanceOf(CheckFailed)
    expect(stdout).toContain('▶ sherif\n')
    expect(gitIn(dir, 'status', '--porcelain')).toBe('M  packages/a/package.json\n')
  })

  it('passes a commit no check has anything to do with, unless a check is required', async () => {
    const dir = committed({ ...clean, 'README.md': '# readme\n' })

    writeFileSync(join(dir, 'README.md'), '# readme\n\nmore\n')
    gitIn(dir, 'add', 'README.md')

    const docs = await run(dir, ['staged', '--only=tsc'])

    expect(docs.result).toBe('ok')
    expect(docs.stdout).toContain(
      '○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files\n',
    )

    const required = await run(dir, ['staged', '--only=tsc', '--require=tsc'])

    expect(required.result).toBeInstanceOf(CheckFailed)
    expect(required.stdout).toContain('✘ tsc no tsconfig.json covers the given files\n')
  })

  it('checks and fixes staged files whose names start with ! or -', async () => {
    const dir = committed({ ...clean, 'x.ts': 'export const x = 1;\n' })

    writeFileSync(join(dir, '!x.ts'), 'export const   bang = 1\n')
    writeFileSync(join(dir, '-x.ts'), 'export const   dash = 1\n')
    writeFileSync(join(dir, 'x.ts'), 'export const   x = 2\n')
    gitIn(dir, 'add', '--', '!x.ts', '-x.ts', 'x.ts')

    const { result, stdout } = await run(dir, ['staged', '--fix', '--only=oxlint', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ all checks passed (oxlint, oxfmt)\n')
    expect(stdout).toContain('✔ staged the fixes to !x.ts -x.ts x.ts\n')
    expect(gitIn(dir, 'show', ':./!x.ts')).toBe('export const bang = 1;\n')
    expect(gitIn(dir, 'show', ':./-x.ts')).toBe('export const dash = 1;\n')
    expect(gitIn(dir, 'show', ':x.ts')).toBe('export const x = 2;\n')
  })

  it.skipIf(process.platform === 'win32')(
    'puts unstaged changes back when a closed terminal hangs up during a slow check',
    async () => {
      const dir = fixture(
        {
          ...clean,
          'node_modules/oxlint/package.json': { name: 'oxlint', bin: 'lint.js' },
          'node_modules/oxlint/lint.js':
            "require('node:fs').writeFileSync('node_modules/started', '')\nsetTimeout(() => {}, 30_000)\n",
        },
        [],
      )
      const file = join(dir, 'src/index.ts')

      gitIn(dir, 'init', '--quiet')
      gitIn(dir, 'add', '.')
      gitIn(dir, 'commit', '--quiet', '-m', 'init')
      writeFileSync(file, 'export const answer: number = 43;\n')
      gitIn(dir, 'add', 'src/index.ts')
      writeFileSync(file, 'export const answer: number = 43;\nexport const more = 1;\n')

      const bin = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))
      const check = spawn(process.execPath, [bin, 'staged', '--only=oxlint'], {
        cwd: dir,
        stdio: 'ignore',
      })
      const exited = once(check, 'exit')
      onTestFinished(() => {
        check.kill('SIGKILL')
      })

      await vi.waitFor(() => expect(existsSync(join(dir, 'node_modules/started'))).toBe(true), {
        timeout: 10_000,
      })
      check.kill('SIGHUP')
      check.kill('SIGHUP')

      expect(await exited).toEqual([130, null])
      expect(readFileSync(file, 'utf8')).toBe(
        'export const answer: number = 43;\nexport const more = 1;\n',
      )
      expect(gitIn(dir, 'status', '--porcelain')).toBe('MM src/index.ts\n')
      expect(existsSync(join(dir, '.git/uncheck-unstaged'))).toBe(false)
    },
  )
})

describe('uncheck staged in a package', { timeout: 120_000 }, () => {
  it('checks and stages from inside a package, the way the hook of a monorepo does', async () => {
    const dir = committed({
      '.oxlintrc.json': oxlintrc,
      'src/root.ts': 'export const root = 1;\n',
      'packages/app/tsconfig.json': standaloneTsconfig,
      'packages/app/src/index.ts': 'export const answer: number = 42;\n',
    })

    writeFileSync(join(dir, 'packages/app/src/index.ts'), 'export const   answer: number = 42\n')
    writeFileSync(join(dir, 'src/root.ts'), 'export const   root = 11\n')
    gitIn(dir, 'add', 'packages/app/src/index.ts', 'src/root.ts')

    const { result, stdout } = await run(join(dir, 'packages/app'), ['staged', '--fix'])

    expect(result).toBe('ok')
    // Staged files outside the package are another line's business, so they are neither checked nor fixed.
    expect(stdout).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts\n')
    expect(stdout).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(stdout).toContain('✔ staged the fixes to src/index.ts\n')
    expect(gitIn(dir, 'show', ':packages/app/src/index.ts')).toBe(
      'export const answer: number = 42;\n',
    )
    expect(gitIn(dir, 'show', ':src/root.ts')).toBe('export const   root = 11\n')
  })

  it('puts unstaged changes back with the line endings the package sets', async () => {
    const crlf = (text: string) => text.replaceAll('\n', '\r\n')
    const lines = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n'
    const dir = committed({
      'packages/app/.gitattributes': '*.ts text eol=crlf\n',
      'packages/app/src/index.ts': crlf(`export const answer: number = 42;\n${lines}`),
    })
    const file = join(dir, 'packages/app/src/index.ts')

    writeFileSync(file, crlf(`export const   answer: number = 43\n${lines}`))
    gitIn(dir, 'add', '.')
    writeFileSync(file, crlf(`export const   answer: number = 43\n${lines}export const d = 4;\n`))

    const { result } = await run(join(dir, 'packages/app'), ['staged', '--fix', '--only=oxfmt'])

    expect(result).toBe('ok')
    expect(gitIn(dir, 'show', ':packages/app/src/index.ts')).toBe(
      `export const answer: number = 43;\n${lines}`,
    )
    expect(readFileSync(file, 'utf8')).toBe(
      crlf(`export const answer: number = 43;\n${lines}export const d = 4;\n`),
    )
  })

  it('reports what git refused to do instead of crashing', async () => {
    const dir = committed(clean)

    writeFileSync(join(dir, 'src/index.ts'), 'export const   answer: number = 42\n')
    gitIn(dir, 'add', 'src/index.ts')
    // A lock left behind by another git process makes every write to the index fail.
    writeFileSync(join(dir, '.git/index.lock'), '')

    await expect(run(dir, ['staged', '--fix'])).rejects.toThrow(/git .* failed:/)
  })
})

describe('uncheck prepare', { timeout: 120_000 }, () => {
  const header = '#!/bin/sh\n# Written by `uncheck prepare`, run it again to change the command.\n'

  let globalConfig = ''

  beforeEach(() => {
    globalConfig = join(fixture({ '.gitconfig': '' }, []), '.gitconfig')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes the pre-commit hook through the detected package manager and updates it in place', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])
    gitIn(dir, 'init', '--quiet')
    const hook = join(dir, '.git/hooks/pre-commit')

    await expect(run(dir, ['prepare'])).rejects.toThrow(/Pass --pre-commit/)
    expect(existsSync(hook)).toBe(false)

    const { result, stdout } = await run(dir, ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ pre-commit .git/hooks/pre-commit created\n')
    expect(stdout).toContain('The hook runs pnpm exec uncheck staged --fix before every commit')
    expect(readFileSync(hook, 'utf8')).toBe(`${header}pnpm exec uncheck staged --fix || exit 1\n`)

    if (process.platform !== 'win32') {
      expect(statSync(hook).mode & 0o111).toBe(0o111)
    }

    const again = await run(dir, ['prepare', '--pre-commit'])

    expect(again.result).toBe('ok')
    expect(again.stdout).toContain('✔ pre-commit .git/hooks/pre-commit unchanged\n')

    const fast = await run(dir, ['prepare', '--pre-commit', '--only=oxlint', '--only=oxfmt'])

    expect(fast.result).toBe('ok')
    expect(fast.stdout).toContain('✔ pre-commit .git/hooks/pre-commit updated\n')
    expect(readFileSync(hook, 'utf8')).toBe(
      `${header}pnpm exec uncheck staged --fix --only=oxlint --only=oxfmt || exit 1\n`,
    )

    const allowEmpty = await run(dir, ['prepare', '--pre-commit', '--allow-empty'])

    expect(allowEmpty.result).toBe('ok')
    expect(readFileSync(hook, 'utf8')).toBe(
      `${header}pnpm exec uncheck staged --fix --allow-empty || exit 1\n`,
    )

    const checkOnly = await run(dir, ['prepare', '--pre-commit', '--no-fix'])

    expect(checkOnly.result).toBe('ok')
    expect(checkOnly.stdout).toContain('The hook runs pnpm exec uncheck staged before every commit')
    expect(readFileSync(hook, 'utf8')).toBe(`${header}pnpm exec uncheck staged || exit 1\n`)

    await expect(
      run(dir, ['prepare', '--pre-commit', '--only=oxlint', '--skip=oxlint']),
    ).rejects.toThrow(/--only=oxlint and --skip=oxlint/)
  })

  it('keeps one line per package, drops duplicates and leaves lines it did not write alone', async () => {
    const dir = fixture(
      { 'package.json': '{}\n', 'pnpm-lock.yaml': '', 'packages/app/package.json': '{}\n' },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    const hook = join(dir, '.git/hooks/pre-commit')
    const app = '(cd "packages/app" && pnpm exec uncheck staged --fix --only=oxlint) || exit 1'

    await run(dir, ['prepare', '--pre-commit'])
    await run(join(dir, 'packages/app'), ['prepare', '--pre-commit', '--only=oxlint'])

    expect(readFileSync(hook, 'utf8')).toBe(
      `${header}pnpm exec uncheck staged --fix || exit 1\n${app}\n`,
    )

    // Preparing the root again leaves the line of the nested package alone.
    const root = await run(dir, ['prepare', '--pre-commit', '--no-fix'])

    expect(root.stdout).toContain('✔ pre-commit .git/hooks/pre-commit updated\n')
    expect(readFileSync(hook, 'utf8')).toBe(`${header}pnpm exec uncheck staged || exit 1\n${app}\n`)

    const mine = 'echo "runs uncheck staged"'

    writeFileSync(
      hook,
      `${header}${mine}\npnpm exec uncheck staged --fix\npnpm test\nnpx uncheck staged --skip=tsc\n`,
    )

    const deduped = await run(dir, ['prepare', '--pre-commit'])

    expect(deduped.stdout).toContain('✔ pre-commit .git/hooks/pre-commit updated\n')
    // The second copy goes, the line that only mentions the command and the unrelated one stay.
    expect(readFileSync(hook, 'utf8')).toBe(
      `${header}${mine}\npnpm exec uncheck staged --fix || exit 1\npnpm test\n`,
    )

    const settled = await run(dir, ['prepare', '--pre-commit'])

    expect(settled.stdout).toContain('✔ pre-commit .git/hooks/pre-commit unchanged\n')

    const chained = 'npx uncheck staged --only=oxfmt && pnpm test'
    const advisory = 'pnpm exec uncheck staged --fix || echo "not blocking"'

    writeFileSync(hook, `#!/bin/sh\n${chained}\n${advisory}\n`)

    const handWritten = await run(dir, ['prepare', '--pre-commit'])

    expect(handWritten.stdout).toContain('✔ pre-commit .git/hooks/pre-commit updated\n')
    expect(readFileSync(hook, 'utf8')).toBe(
      `#!/bin/sh\npnpm exec uncheck staged --fix || exit 1\n${chained}\n${advisory}\n`,
    )
  })

  it.skipIf(process.platform === 'win32')(
    'writes a hook that runs each line from the top of the working tree and fails when any line fails',
    async () => {
      const dir = fixture(
        {
          'package.json': '{}\n',
          'pnpm-lock.yaml': '',
          'packages/a/package.json': '{}\n',
          'packages/b/package.json': '{}\n',
        },
        [],
      )
      gitIn(dir, 'init', '--quiet')
      const top = realpathSync(dir)

      await run(dir, ['prepare', '--pre-commit'])
      await run(join(dir, 'packages/a'), ['prepare', '--pre-commit', '--only=oxlint'])
      await run(join(dir, 'packages/b'), ['prepare', '--pre-commit'])

      const bin = fixture(
        { pnpm: '#!/bin/sh\necho "$(pwd -P) $*" >> "$LOG"\ntest ! -e fail\n' },
        [],
      )
      const log = join(bin, 'log')
      chmodSync(join(bin, 'pnpm'), 0o755)

      function commit() {
        writeFileSync(log, '')

        const { status } = spawnSync('sh', ['.git/hooks/pre-commit'], {
          cwd: dir,
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LOG: log },
        })

        return { status, ran: readFileSync(log, 'utf8').split('\n').filter(Boolean) }
      }

      const root = `${top} exec uncheck staged --fix`
      const a = `${top}/packages/a exec uncheck staged --fix --only=oxlint`
      const b = `${top}/packages/b exec uncheck staged --fix`

      expect(commit()).toEqual({ status: 0, ran: [root, a, b] })

      writeFileSync(join(dir, 'fail'), '')

      expect(commit()).toEqual({ status: 1, ran: [root] })

      rmSync(join(dir, 'fail'))
      writeFileSync(join(dir, 'packages/a/fail'), '')

      expect(commit()).toEqual({ status: 1, ran: [root, a] })
    },
  )

  it('keeps the line of every package when they all prepare at once, as a workspace install does', async () => {
    const packages = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const folders = ['.', ...packages.map((name) => `packages/${name}`)]
    const dir = fixture(
      {
        'pnpm-lock.yaml': '',
        ...Object.fromEntries(folders.map((folder) => [`${folder}/package.json`, '{}\n'])),
      },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    const bin = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))

    const exits = await Promise.all(
      folders.map((folder) => {
        const prepared = spawn(process.execPath, [bin, 'prepare', '--pre-commit'], {
          cwd: join(dir, folder),
          stdio: 'ignore',
        })

        return once(prepared, 'exit')
      }),
    )

    expect(exits.map(([code]) => code)).toEqual(folders.map(() => 0))
    expect(readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8').split('\n').sort()).toEqual(
      [
        ...header.split('\n'),
        'pnpm exec uncheck staged --fix || exit 1',
        ...packages.map(
          (name) => `(cd "packages/${name}" && pnpm exec uncheck staged --fix) || exit 1`,
        ),
      ].sort(),
    )
    expect(readdirSync(join(dir, '.git/hooks')).filter((name) => name.endsWith('.lock'))).toEqual(
      [],
    )
  })

  it.skipIf(process.platform === 'win32')(
    'swaps in the new hook whole, so a commit already running it finishes the old one',
    async () => {
      const dir = fixture(
        { 'package.json': '{}\n', 'pnpm-lock.yaml': '', 'packages/a/package.json': '{}\n' },
        [],
      )
      gitIn(dir, 'init', '--quiet')
      const top = realpathSync(dir)

      await run(dir, ['prepare', '--pre-commit'])
      await run(join(dir, 'packages/a'), ['prepare', '--pre-commit'])

      const bin = fixture(
        {
          pnpm: '#!/bin/sh\necho "$(pwd -P) $*" >> "$LOG"\nwhile [ ! -e "$GO" ]; do sleep 0.05; done\n',
        },
        [],
      )
      const log = join(bin, 'log')
      const go = join(bin, 'go')
      chmodSync(join(bin, 'pnpm'), 0o755)
      writeFileSync(log, '')

      const commit = spawn('sh', ['.git/hooks/pre-commit'], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LOG: log, GO: go },
        stdio: 'ignore',
      })
      const exited = once(commit, 'exit')
      onTestFinished(() => writeFileSync(go, ''))

      await vi.waitFor(() => expect(readFileSync(log, 'utf8')).not.toBe(''), { timeout: 10_000 })

      const { stdout } = await run(dir, ['prepare', '--pre-commit', '--only=oxlint'])

      writeFileSync(go, '')

      expect(stdout).toContain('✔ pre-commit .git/hooks/pre-commit updated\n')
      expect((await exited)[0]).toBe(0)
      expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual([
        `${top} exec uncheck staged --fix`,
        `${top}/packages/a exec uncheck staged --fix`,
      ])
    },
  )

  it.skipIf(process.platform === 'win32')(
    'writes the script a symlinked hook points to, even one not there yet, and keeps the link',
    async () => {
      const dir = fixture(
        {
          'package.json': '{}\n',
          'pnpm-lock.yaml': '',
          'scripts/pre-commit': '#!/bin/sh\npnpm test\n',
        },
        [],
      )
      gitIn(dir, 'init', '--quiet')
      const hook = join(dir, '.git/hooks/pre-commit')
      symlinkSync('../../scripts/pre-commit', hook)

      const { stdout } = await run(dir, ['prepare', '--pre-commit'])

      expect(stdout).toContain('✔ pre-commit .git/hooks/pre-commit updated\n')
      expect(lstatSync(hook).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(dir, 'scripts/pre-commit'), 'utf8')).toBe(
        '#!/bin/sh\npnpm exec uncheck staged --fix || exit 1\npnpm test\n',
      )
      expect(statSync(hook).mode & 0o777).toBe(0o755)

      rmSync(hook)
      symlinkSync('../../scripts/later', hook)

      const dangling = await run(dir, ['prepare', '--pre-commit'])

      expect(dangling.stdout).toContain('✔ pre-commit .git/hooks/pre-commit created\n')
      expect(lstatSync(hook).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(dir, 'scripts/later'), 'utf8')).toBe(
        `${header}pnpm exec uncheck staged --fix || exit 1\n`,
      )
      expect(statSync(hook).mode & 0o777).toBe(0o755)
    },
  )

  it('updates the lines older versions wrote, whichever package prepares next', async () => {
    const dir = fixture(
      {
        'package.json': '{}\n',
        'pnpm-lock.yaml': '',
        'packages/a/package.json': '{}\n',
        'packages/b/package.json': '{}\n',
      },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    const hook = join(dir, '.git/hooks/pre-commit')

    writeFileSync(
      hook,
      [
        `${header}pnpm exec uncheck staged --fix`,
        'pnpm test',
        'cd "packages/a" && pnpm exec uncheck staged --fix --only=oxlint',
        'cd "packages/b" && pnpm exec uncheck staged --fix',
        '',
      ].join('\n'),
    )

    const { stdout } = await run(join(dir, 'packages/b'), ['prepare', '--pre-commit', '--no-fix'])

    expect(stdout).toContain(`✔ pre-commit ${hook} updated\n`)
    expect(readFileSync(hook, 'utf8')).toBe(
      [
        `${header}pnpm exec uncheck staged --fix || exit 1`,
        'pnpm test',
        '(cd "packages/a" && pnpm exec uncheck staged --fix --only=oxlint) || exit 1',
        '(cd "packages/b" && pnpm exec uncheck staged) || exit 1',
        '',
      ].join('\n'),
    )

    const again = await run(join(dir, 'packages/b'), ['prepare', '--pre-commit', '--no-fix'])

    expect(again.stdout).toContain(`✔ pre-commit ${hook} unchanged\n`)
  })

  it('switches the lines older versions wrote to the current runner in place', async () => {
    const npm = fixture({ 'package.json': '{}\n', 'package-lock.json': '{}\n' }, [])
    gitIn(npm, 'init', '--quiet')
    const npmHook = join(npm, '.git/hooks/pre-commit')
    writeFileSync(npmHook, `${header}npx uncheck staged --fix || exit 1\npnpm test\n`)

    await run(npm, ['prepare', '--pre-commit'])

    expect(readFileSync(npmHook, 'utf8')).toBe(
      `${header}npx --no uncheck staged --fix || exit 1\npnpm test\n`,
    )

    const yarn = fixture({ 'package.json': '{}\n', 'yarn.lock': '' }, [])
    gitIn(yarn, 'init', '--quiet')
    const yarnHook = join(yarn, '.git/hooks/pre-commit')
    writeFileSync(yarnHook, '#!/bin/sh\nyarn uncheck staged --fix\npnpm test\n')

    await run(yarn, ['prepare', '--pre-commit'])

    expect(readFileSync(yarnHook, 'utf8')).toBe(
      '#!/bin/sh\nyarn run --silent uncheck staged --fix || exit 1\npnpm test\n',
    )
  })

  it('takes the runner from the packageManager field and reports an unwritable hook', async () => {
    const dir = fixture({ 'package.json': { packageManager: 'bun@1.2.0' } }, [])
    gitIn(dir, 'init', '--quiet')

    const { result, stdout } = await run(dir, ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toContain(
      'The hook runs bunx --no-install uncheck staged --fix before every commit',
    )

    const blocked = fixture({ 'package.json': '{}\n' }, [])
    gitIn(blocked, 'init', '--quiet')
    mkdirSync(join(blocked, '.git/hooks/pre-commit'), { recursive: true })

    // A `prepare` script that fails would fail the install, so it reports and carries on.
    const refused = await run(blocked, ['prepare', '--pre-commit'])

    expect(refused.result).toBe('ok')
    expect(refused.stdout).toContain('✘ pre-commit .git/hooks/pre-commit not written,')
    expect(
      readdirSync(join(blocked, '.git/hooks')).filter(
        (name) => name.includes('uncheck') || name.endsWith('.lock'),
      ),
    ).toEqual([])
  })

  it('adds itself to an existing hook, enters a nested project and does nothing outside git', async () => {
    const dir = fixture(
      { 'package.json': '{}\n', 'packages/app/package.json': '{}\n', 'packages/app/yarn.lock': '' },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    const hook = join(dir, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho hi', { mode: 0o600 })

    const { result, stdout } = await run(join(dir, 'packages/app'), ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toContain(`✔ pre-commit ${hook} updated\n`)
    expect(readFileSync(hook, 'utf8')).toBe(
      '#!/bin/sh\n(cd "packages/app" && yarn run --silent uncheck staged --fix) || exit 1\necho hi',
    )

    if (process.platform !== 'win32') {
      expect(statSync(hook).mode & 0o777).toBe(0o755)
    }

    const plain = fixture({ 'package.json': '{}\n' }, [])
    const skipped = await run(plain, ['prepare', '--pre-commit'])

    expect(skipped.result).toBe('ok')
    expect(skipped.stdout).toBe('○ no git repository found, nothing to prepare\n')
  })

  it.skipIf(process.platform === 'win32')(
    'runs before the commands of an existing hook, so they still fail it and cannot skip it',
    async () => {
      const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])
      gitIn(dir, 'init', '--quiet')
      const hook = join(dir, '.git/hooks/pre-commit')
      const bin = fixture({ pnpm: '#!/bin/sh\necho "$*" >> "$LOG"\ntest "$1" = exec\n' }, [])
      const log = join(bin, 'log')
      chmodSync(join(bin, 'pnpm'), 0o755)
      writeFileSync(join(dir, '.git/hooks/env'), `PATH="${bin}:$PATH"\n`)
      writeFileSync(hook, '#!/bin/sh\n# lint\n. "$(dirname "$0")/env"\nexec pnpm lint-staged\n')

      await run(dir, ['prepare', '--pre-commit'])

      expect(readFileSync(hook, 'utf8')).toBe(
        '#!/bin/sh\n# lint\n. "$(dirname "$0")/env"\npnpm exec uncheck staged --fix || exit 1\nexec pnpm lint-staged\n',
      )

      const { status } = spawnSync('sh', ['.git/hooks/pre-commit'], {
        cwd: dir,
        env: { ...process.env, LOG: log },
      })

      expect(status).toBe(1)
      expect(readFileSync(log, 'utf8')).toBe('exec uncheck staged --fix\nlint-staged\n')
    },
  )

  it('leaves a hook in another language alone and says what it should run', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])
    gitIn(dir, 'init', '--quiet')
    const hook = join(dir, '.git/hooks/pre-commit')
    const script = '#!/usr/bin/env node\nconsole.log("checked")\n'
    writeFileSync(hook, script, { mode: 0o755 })

    const { result, stdout } = await run(dir, ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toBe(
      '✘ pre-commit .git/hooks/pre-commit not written, it is not a shell script, have it run `pnpm exec uncheck staged --fix || exit 1` yourself\n',
    )
    expect(readFileSync(hook, 'utf8')).toBe(script)
  })

  it('writes nothing for a package whose folder name sh would expand', async () => {
    const dir = fixture(
      { 'package.json': '{}\n', 'pnpm-lock.yaml': '', 'packages/a$b/package.json': '{}\n' },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    const hook = join(dir, '.git/hooks/pre-commit')

    const { result, stdout } = await run(join(dir, 'packages/a$b'), ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toBe(
      `✘ pre-commit ${hook} not written, sh would misread the folder name "packages/a$b" between double quotes\n`,
    )
    expect(existsSync(hook)).toBe(false)
  })

  it('writes the hook the husky 9 and Vite+ dispatcher runs, not their generated shim', async () => {
    const dispatcher = [
      's="$(dirname "$(dirname "$0")")/$(basename "$0")"',
      '[ ! -f "$s" ] && exit 0',
      'export PATH="node_modules/.bin:$PATH"',
      'sh -e "$s" "$@"',
      'exit $?',
      '',
    ].join('\n')
    const shim = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'
    const dir = fixture(
      {
        'package.json': '{}\n',
        'pnpm-lock.yaml': '',
        'packages/app/package.json': '{}\n',
        '.husky/_/h': dispatcher,
        '.husky/_/pre-commit': shim,
        '.husky/pre-commit': 'pnpm test\n',
      },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    gitIn(dir, 'config', 'core.hooksPath', '.husky/_')
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755)
    const hook = join(dir, '.husky/pre-commit')
    const app = '(cd "packages/app" && pnpm exec uncheck staged --fix --only=oxlint) || exit 1'

    const { result, stdout } = await run(dir, ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ pre-commit .husky/pre-commit updated\n')

    const nested = await run(join(dir, 'packages/app'), [
      'prepare',
      '--pre-commit',
      '--only=oxlint',
    ])

    expect(nested.stdout).toContain(`✔ pre-commit ${hook} updated\n`)
    expect(readFileSync(hook, 'utf8')).toBe(
      `pnpm exec uncheck staged --fix || exit 1\n${app}\npnpm test\n`,
    )
    expect(readFileSync(join(dir, '.husky/_/pre-commit'), 'utf8')).toBe(shim)

    const again = await run(dir, ['prepare', '--pre-commit'])

    expect(again.stdout).toContain('✔ pre-commit .husky/pre-commit unchanged\n')

    if (process.platform !== 'win32') {
      expect(statSync(hook).mode & 0o111).toBe(0)

      const bin = fixture(
        { pnpm: '#!/bin/sh\necho "$(pwd -P) $*" >> "$LOG"\ntest ! -e fail\n' },
        [],
      )
      const log = join(bin, 'log')
      chmodSync(join(bin, 'pnpm'), 0o755)

      function commit() {
        writeFileSync(log, '')

        const { status } = spawnSync(
          'git',
          [
            '-c',
            'user.name=uncheck',
            '-c',
            'user.email=uncheck@example.com',
            'commit',
            '--allow-empty',
            '--quiet',
            '--message=test',
          ],
          {
            cwd: dir,
            env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LOG: log },
          },
        )

        return { status, ran: readFileSync(log, 'utf8').split('\n').filter(Boolean) }
      }

      const top = realpathSync(dir)

      expect(commit()).toEqual({
        status: 0,
        ran: [
          `${top} exec uncheck staged --fix`,
          `${top}/packages/app exec uncheck staged --fix --only=oxlint`,
          `${top} test`,
        ],
      })

      writeFileSync(join(dir, 'fail'), '')

      expect(commit()).toEqual({ status: 1, ran: [`${top} exec uncheck staged --fix`] })

      chmodSync(hook, 0o755)

      const committed = await run(dir, ['prepare', '--pre-commit', '--no-fix'])

      expect(committed.stdout).toContain('✔ pre-commit .husky/pre-commit updated\n')
      expect(statSync(hook).mode & 0o777).toBe(0o755)
    }

    const vite = fixture(
      { 'package.json': '{}\n', 'pnpm-lock.yaml': '', '.vite-hooks/_/h': dispatcher },
      [],
    )
    gitIn(vite, 'init', '--quiet')
    gitIn(vite, 'config', 'core.hooksPath', '.vite-hooks/_')

    const created = await run(vite, ['prepare', '--pre-commit'])

    expect(created.stdout).toContain('✔ pre-commit .vite-hooks/pre-commit created\n')
    expect(readFileSync(join(vite, '.vite-hooks/pre-commit'), 'utf8')).toBe(
      `${header}pnpm exec uncheck staged --fix || exit 1\n`,
    )
    expect(existsSync(join(vite, '.vite-hooks/_/pre-commit'))).toBe(false)
  })

  it('writes into a core.hooksPath set by hand as it is, even one holding an `h` script', async () => {
    const dir = fixture(
      {
        'package.json': '{}\n',
        'pnpm-lock.yaml': '',
        'packages/app/package.json': '{}\n',
        '.githooks/h': 'echo "help"\n',
      },
      [],
    )
    gitIn(dir, 'init', '--quiet')
    gitIn(dir, 'config', 'core.hooksPath', '.githooks')
    const hook = join(dir, '.githooks/pre-commit')

    const { result, stdout } = await run(dir, ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ pre-commit .githooks/pre-commit created\n')

    await run(join(dir, 'packages/app'), ['prepare', '--pre-commit'])

    expect(readFileSync(hook, 'utf8')).toBe(
      `${header}pnpm exec uncheck staged --fix || exit 1\n(cd "packages/app" && pnpm exec uncheck staged --fix) || exit 1\n`,
    )
    expect(existsSync(join(dir, '.git/hooks/pre-commit'))).toBe(false)
    expect(existsSync(join(dir, 'pre-commit'))).toBe(false)

    if (process.platform !== 'win32') {
      expect(statSync(hook).mode & 0o111).toBe(0o111)
    }
  })

  it('leaves the core.hooksPath of the global git config alone, since every repository runs it', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])
    gitIn(dir, 'init', '--quiet')
    const shared = fixture({ 'pre-commit': '#!/bin/sh\necho "scanning for secrets"\n' }, [])
    gitIn(dir, 'config', '--file', globalConfig, 'core.hooksPath', shared)

    const { result, stdout } = await run(dir, ['prepare', '--pre-commit'])

    expect(result).toBe('ok')
    expect(stdout).toBe(
      `✘ pre-commit ${join(shared, 'pre-commit')} not written, core.hooksPath is set in the global git config, so every repository runs it\n`,
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(
      '#!/bin/sh\necho "scanning for secrets"\n',
    )

    gitIn(dir, 'config', 'core.hooksPath', '.githooks')

    const local = await run(dir, ['prepare', '--pre-commit'])

    expect(local.stdout).toContain('✔ pre-commit .githooks/pre-commit created\n')
  })
})

describe('uncheck presets', { timeout: 120_000 }, () => {
  it('lints with the middleapi oxlint preset and formats with the middleapi oxfmt preset', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintPreset,
      '.oxfmtrc.json': oxfmtPreset,
      'src/index.ts':
        'import { a } from "./lib";\nimport { b } from "./lib";\nconsole.log(a, b)\nexport const enum Level { Low }\n',
      'src/lib.ts': 'export const a = 1\nexport const b = 2\n',
      'src/warn.ts':
        "import { a } from './lib'\nimport { b } from './lib'\n\nexport function pause() {\n  debugger\n  return a + b\n}\n",
      'src/bugs.ts': [
        'export function parse() {',
        '  try { JSON.parse("x") }',
        '  catch (error) { throw new Error("parse failed") }',
        '}',
        'export function assign(a: number, b: number) { a -= a - b; return a }',
        'export function collect(xs: number[]) { let out: number[] = []; for (const x of xs) { out = [...out, x] } return out }',
        'export function confuse(a: string | null, b: string) { return a! == b }',
        'export class Recurse { get v(): number { return this.v } }',
        'export function fill() { return new Array(3).fill([]) }',
        'export function negate(a: boolean, b: boolean) { return !a === b }',
        'export class Construct { constructor() { return { x: 1 } } }',
        '',
      ].join('\n'),
    })

    const check = await run(dir)

    expect(check.result).toBeInstanceOf(CheckFailed)
    expect((check.result as CheckFailed).outcomes).toEqual([
      { name: 'sherif', status: 'skipped', reason: 'no package.json found' },
      { name: 'oxlint', status: 'failed' },
      { name: 'oxfmt', status: 'failed' },
      { name: 'tsc', status: 'skipped', reason: 'no tsconfig.json found' },
    ])
    expect(check.stdout).toContain('eslint(no-console)')
    expect(check.stdout).toContain('import(no-duplicates)')
    expect(check.stdout).toContain('oxc(no-const-enum)')

    for (const rule of [
      'eslint(preserve-caught-error)',
      'oxc(misrefactored-assign-op)',
      'oxc(no-accumulating-spread)',
      'typescript(no-confusing-non-null-assertion)',
      'unicorn(no-accessor-recursion)',
      'unicorn(no-array-fill-with-reference-type)',
      'unicorn(no-negation-in-equality-check)',
      'eslint(no-constructor-return)',
    ]) {
      expect(check.stdout).toContain(rule)
    }

    // `warn` rules, a default one and `import/no-duplicates`, report without failing the run; the
    // output format depends on the environment (a terminal, CI or an agent), so only names are matched
    const warned = await run(dir, ['--only=oxlint', 'src/warn.ts'])

    expect(warned.result).toBe('ok')
    expect(warned.stdout).toContain('eslint(no-debugger)')
    expect(warned.stdout).toContain('import(no-duplicates)')

    const fix = await run(dir, ['--fix'])

    expect(fix.result).toBeInstanceOf(CheckFailed)
    expect(fix.stdout).toContain('eslint(no-console)')
    expect(fix.stdout).not.toContain('import(no-duplicates)')
    expect(fix.stdout).not.toContain('oxc(no-const-enum)')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe(
      "import { a, b } from './lib'\nconsole.log(a, b)\nexport enum Level {\n  Low,\n}\n",
    )
  })

  it('type checks with the middleapi tsconfig presets', async () => {
    const dir = fixture(
      {
        'tsconfig.json': { extends: 'uncheck/tsconfig/middleapi/lib', include: ['src'] },
        'src/index.ts': [
          'export function identity(value) {',
          '  return value',
          '}',
          'export function first(items: string[]): string {',
          '  return items[0]',
          '}',
          '',
        ].join('\n'),
        'src/use.ts':
          "import { first } from './index.ts'\n\nexport const name: string = first(['a'])\n",
      },
      ['typescript'],
    )
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(dir, 'node_modules', 'uncheck'))

    const check = await run(dir, ['--only=tsc', 'src/index.ts'])

    expect(check.result).toBeInstanceOf(CheckFailed)
    expect(check.stdout).toContain('▶ tsc -p tsconfig.json --noEmit')
    // `strict` and `noUncheckedIndexedAccess` come from the base preset, through the lib one
    expect(check.stdout).toContain('error TS7006')
    expect(check.stdout).toContain('error TS2322')
    // Node runs TypeScript only through imports that name the .ts file.
    expect(check.stdout).not.toContain('TS5097')
  })
})
