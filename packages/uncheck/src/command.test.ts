import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Sink, Stdio, Stream, Terminal } from 'effect'
import { Command } from 'effect/unstable/cli'
import { CheckFailed, command, UncheckOptions } from './index'

const TOOLS = ['oxlint', 'oxfmt', 'typescript'] as const

const packageNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url))
const fixtures: string[] = []

afterAll(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Creates a throwaway project in the OS temp dir. The requested tools are symlinked into its
 * `node_modules` so they resolve exactly like a regular install would. Config files are kept out
 * of the format step so tests only see the formatting issues they put in.
 */
function fixture(files: Record<string, string>, tools: ReadonlyArray<(typeof TOOLS)[number]> = TOOLS): string {
  const dir = mkdtempSync(join(tmpdir(), 'uncheck-'))
  fixtures.push(dir)

  if (tools.length > 0) {
    mkdirSync(join(dir, 'node_modules'))

    for (const tool of tools) {
      symlinkSync(realpathSync(join(packageNodeModules, tool)), join(dir, 'node_modules', tool))
    }
  }

  const defaults = {
    '.gitignore': 'node_modules\ndist\n',
    '.prettierignore': 'tsconfig.json\n.oxlintrc.json\n',
  }

  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true })
    writeFileSync(join(dir, relative), content)
  }

  return dir
}

interface RunResult {
  readonly result: 'ok' | CheckFailed
  /** Everything written through the terminal, without ANSI styling. */
  readonly output: string
  readonly stdout: string
  readonly stderr: string
}

async function run(cwd: string, args: ReadonlyArray<string> = [], stdin = ''): Promise<RunResult> {
  const output: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const decoder = new TextDecoder()
  const collect = (into: string[]) => () =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        into.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk))
      }),
    )

  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.die('unused'),
    readLine: Effect.die('unused'),
    display: text =>
      Effect.sync(() => {
        output.push(text)
      }),
  })

  const result = await Effect.runPromise(
    Command.runWith(command, { version: '0.0.0' })(args).pipe(
      Effect.map(() => 'ok' as const),
      Effect.catchTag('CheckFailed', error => Effect.succeed(error)),
      Effect.provideService(UncheckOptions, { cwd, stdio: 'pipe' }),
      // Inner layers take precedence, so these replace the Node terminal and stdio.
      Effect.provide(Layer.succeed(Terminal.Terminal, terminal)),
      Effect.provide(
        Stdio.layerTest({
          stdin: Stream.make(new TextEncoder().encode(stdin)),
          stdout: collect(stdout),
          stderr: collect(stderr),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  )

  return {
    result,
    output: stripVTControlCharacters(output.join('')),
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  }
}

const oxlintrc = JSON.stringify({ rules: { 'no-var': 'error' } })

const standaloneTsconfig = JSON.stringify({
  compilerOptions: { noEmit: true, strict: true, module: 'esnext', moduleResolution: 'bundler', types: [] },
  include: ['src', 'scripts'],
})

function compositeTsconfig(references: string[] = []) {
  return JSON.stringify({
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
  })
}

describe('uncheck', { timeout: 120_000 }, () => {
  it('runs lint, format and typecheck and passes on a clean project', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'src/index.ts': 'export const answer: number = 42;\n',
    })

    const { result, output } = await run(dir)

    expect(result).toBe('ok')
    expect(output).toContain('▶ oxlint\n')
    expect(output).toContain('▶ oxfmt --check\n')
    expect(output).toContain('▶ tsc -p tsconfig.json\n')
    expect(output).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')
  })

  it('reports lint and format failures, then fixes them with --fix', async () => {
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
    expect(check.output).toContain('no-var')
    expect(check.output).toContain('✘ 2 of 3 checks failed: oxlint, oxfmt')
    expect(check.output).toContain('run `uncheck --fix` to apply oxlint and oxfmt fixes')

    const fix = await run(dir, ['--fix'])

    expect(fix.result).toBe('ok')
    expect(fix.output).toContain('▶ oxlint --fix\n')
    expect(fix.output).toContain('▶ oxfmt\n')
    expect(readFileSync(join(dir, 'src/legacy.ts'), 'utf8')).toBe('const count = 1;\nexport { count };\n')
    expect(readFileSync(join(dir, 'src/ugly.ts'), 'utf8')).toBe('export const ugly = { a: 1, b: 2 };\n')

    expect((await run(dir)).result).toBe('ok')
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

    const { result, output } = await run(dir)

    expect(result).toBe('ok')
    expect(output).toContain('▶ tsc -b packages/app/tsconfig.json\n▶ tsc -p tsconfig.json\n')
    expect(output).not.toContain('packages/lib/tsconfig.json')

    writeFileSync(join(dir, 'packages/lib/src/index.ts'), 'export const answer: number = "42";\n')

    const broken = await run(dir)

    expect(broken.result).toBeInstanceOf(CheckFailed)
    expect((broken.result as CheckFailed).outcomes).toEqual([
      { name: 'oxlint', status: 'passed' },
      { name: 'oxfmt', status: 'passed' },
      { name: 'tsc', status: 'failed' },
    ])
    expect(broken.output).toContain('packages/lib/src/index.ts')
    expect(broken.output).toContain('TS2322')
  })

  it('forwards paths to oxlint and oxfmt and narrows typecheck to the projects containing them', async () => {
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
    expect(scoped.output).not.toContain('no-var')
    expect(scoped.output).toContain('▶ oxlint --no-error-on-unmatched-pattern packages/app\n')
    expect(scoped.output).toContain('▶ oxfmt --check --no-error-on-unmatched-pattern packages/app\n')
    // The root project's inputs (src, scripts) do not reach into packages/app, so only app is built.
    expect(scoped.output).toContain('▶ tsc -b packages/app/tsconfig.json\n✔ tsc')
    expect(scoped.output).not.toContain('tsc -p tsconfig.json')

    const single = await run(dir, ['--fix', 'scripts/hello.ts'])

    expect(single.result).toBe('ok')
    expect(single.output).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern scripts/hello.ts\n')
    expect(single.output).toContain('▶ oxfmt --no-error-on-unmatched-pattern scripts/hello.ts\n')
    expect(single.output).toContain('▶ tsc -p tsconfig.json\n')
    expect(single.output).not.toContain('tsc -b')

    const docs = await run(dir, ['README.md'])

    expect(docs.result).toBe('ok')
    expect(docs.output).toContain('○ tsc skipped, no tsconfig.json covers the given paths\n')
    expect(docs.output).toContain('✔ all checks passed (oxlint, oxfmt)')
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
    expect(walked.output).toContain('▶ tsc -p ignored/tsconfig.json\n')

    const repo = fixture(files, ['typescript'])
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    const tracked = await run(repo)

    expect(tracked.result).toBe('ok')
    expect(tracked.output).not.toContain('ignored/tsconfig.json')
    expect(tracked.output).toContain('○ oxlint skipped, not installed\n')
    expect(tracked.output).toContain('○ oxfmt skipped, not installed\n')
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

    const { result, output } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect(output).toContain(
      '✘ tsc circular project references between packages/a/tsconfig.json, packages/b/tsconfig.json\n',
    )
  })

  it('fails when a tsconfig.json exists but typescript is not installed', async () => {
    const dir = fixture(
      {
        'tsconfig.json': standaloneTsconfig,
        'src/index.ts': 'export const answer = 42;\n',
      },
      [],
    )

    const { result, output } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect((result as CheckFailed).outcomes.map(outcome => outcome.status)).toEqual(['skipped', 'skipped', 'failed'])
    expect(output).toContain('found 1 tsconfig.json but typescript is not installed')
  })

  it('fails when there is nothing to check', async () => {
    const dir = fixture({ 'package.json': '{}\n' }, [])

    const { result, output } = await run(dir)

    expect(result).toBeInstanceOf(CheckFailed)
    expect((result as CheckFailed).outcomes.map(outcome => outcome.status)).toEqual(['skipped', 'skipped', 'skipped'])
    expect(output).toContain('nothing to check: oxlint not installed, oxfmt not installed, tsc no tsconfig.json found')
  })
})

describe('uncheck hooks', { timeout: 120_000 }, () => {
  it('writes hook configs for the named agents through the detected package manager', async () => {
    const dir = fixture({ 'package.json': '{}\n', 'pnpm-lock.yaml': '' }, [])

    const { result, output } = await run(dir, ['hooks', 'claude', 'cursor', 'windsurf', 'copilot'])

    expect(result).toBe('ok')
    expect(output).toContain('✔ Claude Code .claude/settings.json created\n')
    expect(output).toContain('✔ Cursor .cursor/hooks.json created\n')
    expect(output).toContain('pnpm exec uncheck --fix --hook')

    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [{ type: 'command', command: 'pnpm exec uncheck --fix --hook' }],
          },
        ],
      },
    })
    expect(JSON.parse(readFileSync(join(dir, '.cursor/hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { afterFileEdit: [{ command: 'pnpm exec uncheck --fix --hook' }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.windsurf/hooks.json'), 'utf8'))).toEqual({
      hooks: { post_write_code: [{ command: 'pnpm exec uncheck --fix --hook', show_output: true }] },
    })
    expect(JSON.parse(readFileSync(join(dir, '.github/hooks/uncheck.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: {
        postToolUse: [
          { type: 'command', bash: 'pnpm exec uncheck --fix --hook', powershell: 'pnpm exec uncheck --fix --hook' },
        ],
      },
    })

    const again = await run(dir, ['hooks', 'claude'])

    expect(again.result).toBe('ok')
    expect(again.output).toContain('✔ Claude Code .claude/settings.json unchanged\n')
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

    const { result, output } = await run(dir, ['hooks', 'codebuddy', 'claude'])

    expect(result).toBe('ok')
    expect(output).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(output).toContain('✔ CodeBuddy .codebuddy/settings.json created\n')
    expect(output).toContain('npx uncheck --fix --hook')

    expect(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo done' }] },
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [{ type: 'command', command: 'npx uncheck --fix --hook' }],
          },
        ],
      },
    })
  })

  it('rejects unknown agents', async () => {
    const dir = fixture({ 'package.json': '{}\n' }, [])

    await expect(run(dir, ['hooks', 'emacs'])).rejects.toThrow()
  })
})

function claudePayload(filePath: string) {
  return JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: filePath } })
}

describe('uncheck --hook', { timeout: 120_000 }, () => {
  it('fixes the edited file and hands remaining problems back to the agent', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'src/index.ts': 'export const   answer: string = 1\n',
      'src/other.ts': 'export const   other = 2\n',
    })

    const { result, output, stdout, stderr } = await run(
      dir,
      ['--fix', '--hook'],
      claudePayload(join(dir, 'src/index.ts')),
    )

    expect(result).toBe('ok')
    expect(output).toBe('')
    expect(stderr).toContain('▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts\n')
    expect(stderr).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/index.ts\n')
    expect(stderr).toContain('▶ tsc -p tsconfig.json\n')
    expect(stderr).toContain('TS2322')
    expect(stderr).toContain('✘ 1 of 3 checks failed: tsc')

    const hookOutput = JSON.parse(stdout) as { additionalContext: string; hookSpecificOutput: Record<string, string> }

    expect(hookOutput.additionalContext).toContain('uncheck found problems in src/index.ts')
    expect(hookOutput.additionalContext).toContain('TS2322')
    expect(hookOutput.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: hookOutput.additionalContext,
    })

    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toBe('export const answer: string = 1;\n')
    expect(readFileSync(join(dir, 'src/other.ts'), 'utf8')).toBe('export const   other = 2\n')
  })

  it('stays silent when everything passes and when the payload names no project file', async () => {
    const dir = fixture({
      '.oxlintrc.json': oxlintrc,
      'tsconfig.json': standaloneTsconfig,
      'src/index.ts': 'export const answer: number = 42;\n',
    })

    const clean = await run(dir, ['--fix', '--hook'], JSON.stringify({ file_path: join(dir, 'src/index.ts') }))

    expect(clean.result).toBe('ok')
    expect(clean.stdout).toBe('')
    expect(clean.stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')

    for (const payload of [
      claudePayload('/etc/hosts'),
      claudePayload(join(dir, 'src/missing.ts')),
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'not json',
    ]) {
      const ignored = await run(dir, ['--fix', '--hook'], payload)

      expect(ignored.result).toBe('ok')
      expect(ignored.stdout).toBe('')
      expect(ignored.stderr).toBe('')
    }
  })
})

describe('uncheck step flags', { timeout: 120_000 }, () => {
  it('skips a step with --<tool>=false and requires it with --<tool>', async () => {
    const dir = fixture(
      {
        '.oxlintrc.json': oxlintrc,
        'tsconfig.json': standaloneTsconfig,
        'src/index.ts': 'export const answer: string = 1;\n',
      },
      ['oxlint', 'typescript'],
    )

    const skipped = await run(dir, ['--tsc=false'])

    expect(skipped.result).toBe('ok')
    expect(skipped.output).toContain('○ oxfmt skipped, not installed\n')
    expect(skipped.output).toContain('○ tsc skipped, disabled with --tsc=false\n')
    expect(skipped.output).toContain('✔ all checks passed (oxlint)')

    const required = await run(dir, ['--oxfmt', '--tsc=false'])

    expect(required.result).toBeInstanceOf(CheckFailed)
    expect(required.output).toContain('✘ oxfmt not installed\n')
    expect(required.output).toContain('✘ 1 of 2 checks failed: oxfmt')

    const none = await run(dir, ['--no-oxlint', '--no-oxfmt', '--no-tsc'])

    expect(none.result).toBeInstanceOf(CheckFailed)
    expect(none.output).toContain(
      'nothing to check: oxlint disabled with --oxlint=false, oxfmt disabled with --oxfmt=false, tsc disabled with --tsc=false',
    )
  })
})
