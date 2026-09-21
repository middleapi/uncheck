import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import { Console, Effect, Stdio, Stream } from 'effect'
import { Command } from 'effect/unstable/cli'
import { fixture } from './fixture'
import { uncheck } from '../src/commands/uncheck'
import { CheckFailed } from '../src/errors'

interface RunResult {
  readonly result: 'ok' | 'blocked' | CheckFailed
  /** Everything logged, one line each, without ANSI styling. */
  readonly stdout: string
  readonly stderr: string
}

/** Runs the CLI in `cwd`; the flag goes after the subcommand names so it lands on the command that runs. */
async function run(cwd: string, args: ReadonlyArray<string> = [], stdin = ''): Promise<RunResult> {
  const verbs = args[0] === 'hooks' ? 2 : 0
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
    Command.runWith(uncheck, { version: '0.0.0' })(argv).pipe(
      Effect.map(() => 'ok' as const),
      Effect.catchTag('CheckFailed', error => Effect.succeed(error)),
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
  return stripVTControlCharacters(lines.map(line => `${line}\n`).join(''))
}

const oxlintrc = { rules: { 'no-var': 'error' } }

const standaloneTsconfig = {
  compilerOptions: { noEmit: true, strict: true, module: 'esnext', moduleResolution: 'bundler', types: [] },
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
    references: references.map(path => ({ path })),
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
      { name: 'oxlint', status: 'failed' },
      { name: 'oxfmt', status: 'failed' },
      { name: 'tsc', status: 'passed' },
    ])
    expect(check.stdout).toContain('no-var')
    expect(check.stdout).toContain('✘ 2 of 3 checks failed: oxlint, oxfmt')
    expect(check.stdout).toContain('run `uncheck --fix` to apply oxlint and oxfmt fixes')

    const fix = await run(dir, ['--fix'])

    expect(fix.result).toBe('ok')
    expect(fix.stdout).toContain('▶ oxlint --fix\n')
    expect(fix.stdout).toContain('▶ oxfmt\n')
    expect(readFileSync(join(dir, 'src/legacy.ts'), 'utf8')).toBe('const count = 1;\nexport { count };\n')
    expect(readFileSync(join(dir, 'src/ugly.ts'), 'utf8')).toBe('export const ugly = { a: 1, b: 2 };\n')

    const clean = await run(dir)

    expect(clean.result).toBe('ok')
    expect(clean.stdout.startsWith(`uncheck in ${dir}\n▶ oxlint\n`)).toBe(true)
    expect(clean.stdout).toContain('▶ oxlint\n')
    expect(clean.stdout).toContain('▶ oxfmt --check\n')
    expect(clean.stdout).toContain('▶ tsc -p tsconfig.json\n')
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
    expect(stdout).toContain('▶ tsc -b packages/app/tsconfig.json\n▶ tsc -p tsconfig.json\n')
    expect(stdout).not.toContain('packages/lib/tsconfig.json')

    writeFileSync(join(dir, 'packages/lib/src/index.ts'), 'export const answer: number = "42";\n')

    const broken = await run(dir)

    expect(broken.result).toBeInstanceOf(CheckFailed)
    expect((broken.result as CheckFailed).outcomes).toEqual([
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
    expect(single.stdout).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern scripts/hello.ts\n')
    expect(single.stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern scripts/hello.ts\n')
    expect(single.stdout).toContain('▶ tsc -p tsconfig.json\n')
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

    const lenient = await run(dir, ['--no-error-on-unmatched-pattern', 'src/index.ts', 'missing.ts'])

    expect(lenient.result).toBe('ok')
    expect(lenient.stdout).toContain('▶ oxlint --no-error-on-unmatched-pattern src/index.ts\n')

    const nothing = await run(dir, ['--no-error-on-unmatched-pattern', 'missing.ts'])

    expect(nothing.result).toBe('ok')
    expect(nothing.stdout).toBe(`uncheck in ${dir}\n○ nothing to check, no files match missing.ts\n`)
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
    expect(walked.stdout).toContain('▶ tsc -p ignored/tsconfig.json\n')

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
    const dir = fixture({ 'tsconfig.json': standaloneTsconfig, 'src/index.ts': 'export const answer = 42;\n' }, [])

    const { result, stdout } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect((result as CheckFailed).outcomes.map(outcome => outcome.status)).toEqual(['skipped', 'skipped', 'failed'])
    expect(stdout).toContain('found 1 tsconfig.json but typescript is not installed')
  })

  it('fails when there is nothing to check', async () => {
    const dir = fixture({ 'package.json': '{}\n' }, [])

    const { result, stdout } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect((result as CheckFailed).outcomes.map(outcome => outcome.status)).toEqual(['skipped', 'skipped', 'skipped'])
    expect(stdout).toContain('nothing to check: oxlint not installed, oxfmt not installed, tsc no tsconfig.json found')
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

    await expect(run(dir, ['--require=tsc', '--skip=tsc'])).rejects.toThrow(/--require=tsc and --skip=tsc/)

    const none = await run(dir, ['--skip=oxlint', '--skip=oxfmt', '--skip=tsc'])

    expect(none.result).toBeInstanceOf(CheckFailed)
    expect(none.stdout).toContain(
      'nothing to check: oxlint disabled with --skip=oxlint, oxfmt disabled with --skip=oxfmt, tsc disabled with --skip=tsc',
    )
  })
})

describe('uncheck hooks install', { timeout: 120_000 }, () => {
  it('writes stop hook configs for the named agents through the detected package manager', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])

    const { result, stdout } = await run(dir, ['hooks', 'install', 'claude', 'cursor', 'windsurf', 'copilot'])

    expect(result).toBe('ok')
    expect(stdout).toContain('✔ Claude Code .claude/settings.json created\n')
    expect(stdout).toContain('✔ Cursor .cursor/hooks.json created\n')
    expect(stdout).toContain('pnpm exec uncheck hooks run --fix')

    const hook = 'pnpm exec uncheck hooks run --fix'

    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.cursor/hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: hook }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.windsurf/hooks.json'), 'utf8'))).toEqual({
      hooks: { post_cascade_response: [{ command: hook, show_output: true }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.github/hooks/uncheck.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: hook, powershell: hook }] },
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
    expect(stdout).toContain('npx uncheck hooks run --fix')

    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo done' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'npx uncheck hooks run --fix' }] }],
      },
    })
  })

  it('rejects unknown agents', async () => {
    const dir = fixture({ 'package.json': '{}\n' }, [])

    await expect(run(dir, ['hooks', 'install', 'emacs'])).rejects.toThrow()
  })
})

/** A git repository with one clean commit, so later edits show up as working-tree changes. */
function committed(files: Record<string, string | object>) {
  const dir = fixture(files)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=uncheck', '-c', 'user.email=uncheck@example.com', ...args], { cwd: dir })

  git('init', '--quiet')
  git('add', '.')
  git('commit', '--quiet', '-m', 'init')

  return dir
}

describe('uncheck hooks run', { timeout: 120_000 }, () => {
  const clean = {
    '.oxlintrc.json': oxlintrc,
    'tsconfig.json': standaloneTsconfig,
    'src/index.ts': 'export const answer: number = 42;\n',
    'src/other.ts': 'export const other = 2;\n',
  }

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
    expect(claude.stderr).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern src/fresh.ts src/index.ts\n')
    expect(claude.stderr).toContain('▶ tsc -p tsconfig.json\n')
    expect(claude.stderr).toContain('TS2322')
    expect(claude.stderr).toContain('✘ 1 of 3 checks failed: tsc')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe('export const answer: string = 1;\n')

    const continuing = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }),
    )

    expect(continuing.result).toBe('ok')
    expect(continuing.stdout).toBe('')
    expect(continuing.stderr).toContain('TS2322')

    const cursor = await run(dir, ['hooks', 'run', '--fix'], JSON.stringify({ hook_event_name: 'stop', loop_count: 0 }))

    expect(cursor.result).toBe('ok')
    expect((JSON.parse(cursor.stdout) as { followup_message: string }).followup_message).toContain('TS2322')

    const copilot = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ stopReason: 'end_turn', stop_hook_active: false }),
    )

    expect(copilot.result).toBe('ok')
    expect(JSON.parse(copilot.stdout)).toMatchObject({ decision: 'block' })

    const windsurf = await run(
      dir,
      ['hooks', 'run', '--fix'],
      JSON.stringify({ agent_action_name: 'post_cascade_response' }),
    )

    expect(windsurf.result).toBe('ok')
    expect(windsurf.stdout).toBe('')
    expect(windsurf.stderr).toContain('TS2322')
  })

  it('stays silent when nothing changed and passes quietly when the changes are clean', async () => {
    const dir = committed(clean)

    const nothing = await run(dir, ['hooks', 'run', '--fix'], JSON.stringify({ hook_event_name: 'Stop' }))

    expect(nothing.result).toBe('ok')
    expect(nothing.stdout).toBe('')
    expect(nothing.stderr).toBe('')

    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 3;\n')

    const ok = await run(dir, ['hooks', 'run', '--fix'], JSON.stringify({ hook_event_name: 'Stop' }))

    expect(ok.result).toBe('ok')
    expect(ok.stdout).toBe('')
    expect(ok.stderr).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern src/other.ts\n')
    expect(ok.stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')
  })

  it('checks everything under the directory outside a git repository', async () => {
    const dir = fixture(clean)

    const { result, stderr } = await run(dir, ['hooks', 'run'], '{}')

    expect(result).toBe('ok')
    expect(stderr).toContain('▶ oxlint\n')
    expect(stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')
  })
})
