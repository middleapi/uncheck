import type { PlatformError } from 'effect'
import { stripVTControlCharacters } from 'node:util'
import { Console, Data, Effect, FileSystem, Option, Path, Predicate, Stdio, Stream } from 'effect'
import { Argument, CliError, Command, Prompt } from 'effect/unstable/cli'
import { parse as parseJsonc } from 'jsonc-parser'
import { fixFlag, runChecks, stepFlags } from './checks'
import { listChangedFiles } from './files'
import { UncheckOptions } from './options'
import { ancestors, readJson } from './resolve'
import { bold, dim, green, line } from './ui'

interface HookIntegration {
  readonly id: string
  readonly name: string
  /** Config file the agent reads, relative to the project root. */
  readonly path: string
  /** Config for the hook that fires when the agent finishes a turn, written or merged into that file. */
  readonly content: (command: string) => Record<string, unknown>
}

function claudeStyle(command: string): Record<string, unknown> {
  return { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }
}

const HOOK_INTEGRATIONS = [
  { id: 'claude', name: 'Claude Code', path: '.claude/settings.json', content: claudeStyle },
  { id: 'codebuddy', name: 'CodeBuddy', path: '.codebuddy/settings.json', content: claudeStyle },
  {
    id: 'cursor',
    name: 'Cursor',
    path: '.cursor/hooks.json',
    content: command => ({ version: 1, hooks: { stop: [{ command }] } }),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    path: '.windsurf/hooks.json',
    content: command => ({ hooks: { post_cascade_response: [{ command, show_output: true }] } }),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    path: '.github/hooks/uncheck.json',
    content: command => ({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: command, powershell: command }] },
    }),
  },
] as const satisfies ReadonlyArray<HookIntegration>

type HookAgent = (typeof HOOK_INTEGRATIONS)[number]['id']

const HOOK_AGENTS = HOOK_INTEGRATIONS.map(integration => integration.id)

const installCommand = Command.make(
  'install',
  {
    agents: Argument.Literals('agents', HOOK_AGENTS).pipe(
      Argument.variadic(),
      Argument.withDescription(`Agents to configure: ${HOOK_AGENTS.join(', ')}. Prompts for a selection when omitted.`),
    ),
  },
  ({ agents }) =>
    Effect.gen(function* () {
      const { cwd } = yield* UncheckOptions
      const selected: ReadonlyArray<HookAgent> = agents.length > 0 ? agents : yield* promptAgents
      const command = yield* hookCommand(cwd)

      for (const integration of HOOK_INTEGRATIONS) {
        if (!selected.includes(integration.id)) {
          continue
        }

        const result = yield* installHook(integration, command, cwd)

        yield* line(`${green('✔')} ${bold(integration.name)} ${dim(`${integration.path} ${result}`)}`)
      }

      yield* line('')
      yield* line(`${dim('The hook runs')} ${bold(command)} ${dim('whenever the agent finishes a turn.')}`)
    }),
).pipe(Command.withDescription('Write the agent hook configs that run `uncheck hooks run` after every agent turn'))

/** Raised when the agent must keep working; the entry point turns it into exit code 2. */
export class StopBlocked extends Data.TaggedError('StopBlocked')<{}> {}

const runCommand = Command.make('run', { fix: fixFlag, ...stepFlags }, ({ fix, ...flags }) =>
  Effect.gen(function* () {
    const options = yield* UncheckOptions
    const stdio = yield* Stdio.Stdio
    const path = yield* Path.Path

    if (yield* stdio.stdinIsTerminal) {
      const userMessage = '`uncheck hooks run` expects the agent hook payload as JSON on stdin'
      return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
    }

    const payload = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
      Effect.flatMap(text => Effect.try(() => JSON.parse(text) as unknown)),
      Effect.map(value => (Predicate.isObject(value) ? value : {})),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    )

    const cwd = path.resolve(options.cwd)
    const changed = yield* listChangedFiles(cwd)

    if (changed?.length === 0) {
      return
    }

    const lines: string[] = []

    const capture: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...parts: ReadonlyArray<unknown>) => {
        lines.push(parts.join(' '))
      },
    })

    const failed = yield* runChecks(changed ?? [], { fix, flags, allowUnmatched: true }).pipe(
      Effect.map(() => false),
      Effect.catchTag('CheckFailed', () => Effect.succeed(true)),
      Effect.provideService(Console.Console, capture),
    )

    const report = stripVTControlCharacters(lines.join('\n'))

    yield* Console.error(report)

    if (!failed) {
      return
    }

    const reason = `uncheck found problems, fix them before finishing:\n\n${report}`

    yield* stopFeedback(payload, reason)
  }),
).pipe(
  Command.withDescription(
    'Run as an agent stop hook: check the files changed since the last commit, report on stderr and send the agent back to fix what remains',
  ),
)

export const hooksCommand = Command.make('hooks').pipe(
  Command.withDescription('Agent hooks: `install` writes the configs, `run` is what they execute'),
  Command.withSubcommands([installCommand, runCommand]),
)

/**
 * Sends the agent back to work in the way its family understands, at most once per turn.
 *
 * Claude Code and CodeBuddy block on exit code 2 with stderr as the message and mark the payload
 * with `stop_hook_active` once they are already continuing. Cursor continues on a `followup_message`
 * and counts its follow-ups in `loop_count`. Copilot continues on `decision: "block"` and also sets
 * `stop_hook_active`. Anything else, such as Windsurf, only gets the report.
 */
export function stopFeedback(payload: Record<string, unknown>, reason: string) {
  const agent = stopAgent(payload)
  const alreadyContinued =
    payload.stop_hook_active === true || (typeof payload.loop_count === 'number' && payload.loop_count > 0)

  if (agent === undefined || alreadyContinued) {
    return Effect.void
  }

  switch (agent) {
    case 'claude':
      return Effect.fail(new StopBlocked())
    case 'cursor':
      return Console.log(JSON.stringify({ followup_message: reason }))
    case 'copilot':
      return Console.log(JSON.stringify({ decision: 'block', reason }))
  }
}

/** Which family of stop payload this is, judged by the fields each agent documents. */
export function stopAgent(payload: Record<string, unknown>): 'claude' | 'cursor' | 'copilot' | undefined {
  if (payload.hook_event_name === 'Stop') {
    return 'claude'
  }

  if (payload.hook_event_name === 'stop') {
    return 'cursor'
  }

  if (typeof payload.stopReason === 'string') {
    return 'copilot'
  }

  return undefined
}

const promptAgents = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio

  if (!(yield* stdio.stdinIsTerminal)) {
    const userMessage = `Pass the agents to configure, for example: uncheck hooks install ${HOOK_AGENTS.join(' ')}`
    return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
  }

  return yield* Prompt.run(
    Prompt.MultiSelect({
      message: 'Which agents should run uncheck when they finish a turn?',
      choices: HOOK_INTEGRATIONS.map(integration => ({ title: integration.name, value: integration.id })),
      min: 1,
    }),
  )
})

const EXEC_BY_PACKAGE_MANAGER: Readonly<Record<string, string>> = {
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  bun: 'bunx',
  npm: 'npx',
}

const EXEC_BY_LOCKFILE: ReadonlyArray<readonly [lockfile: string, exec: string]> = [
  ['pnpm-lock.yaml', 'pnpm exec'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bunx'],
  ['bun.lockb', 'bunx'],
  ['package-lock.json', 'npx'],
]

/** The hook command, invoking the project's own `uncheck` through the package manager in use. */
function hookCommand(cwd: string): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    for (const dir of ancestors(path, cwd)) {
      const manifest = yield* readJson<{ packageManager?: string }>(path.join(dir, 'package.json'))
      const declared = EXEC_BY_PACKAGE_MANAGER[manifest?.packageManager?.split('@')[0] ?? '']

      if (declared !== undefined) {
        return `${declared} uncheck hooks run --fix`
      }

      const lockfile = yield* Effect.findFirst(EXEC_BY_LOCKFILE, ([file]) =>
        fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
      )

      if (Option.isSome(lockfile)) {
        return `${lockfile.value[1]} uncheck hooks run --fix`
      }
    }

    return 'npx uncheck hooks run --fix'
  })
}

/**
 * Writes the agent's hook config, merging into an existing file so other hooks are kept.
 * A file that already mentions `uncheck` is left alone, which makes reruns safe.
 */
function installHook(
  integration: HookIntegration,
  command: string,
  cwd: string,
): Effect.Effect<'created' | 'updated' | 'unchanged', PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(cwd, integration.path)
    const addition = integration.content(command)

    const existing = yield* fs.readFileString(file).pipe(Effect.option)

    if (Option.isNone(existing)) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, `${JSON.stringify(addition, null, 2)}\n`)
      return 'created'
    }

    if (existing.value.includes('uncheck')) {
      return 'unchanged'
    }

    const current = parseJsonc(existing.value, undefined, { allowTrailingComma: true }) as unknown
    const merged = mergeJson(Predicate.isObject(current) ? current : {}, addition)

    yield* fs.writeFileString(file, `${JSON.stringify(merged, null, 2)}\n`)

    return 'updated'
  })
}

/** Deep-merges plain objects and concatenates arrays, so hook lists grow instead of being replaced. */
function mergeJson(base: unknown, addition: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(addition)) {
    return [...base, ...addition]
  }

  if (Predicate.isObject(base) && Predicate.isObject(addition)) {
    const merged: Record<string, unknown> = { ...base }

    for (const [key, value] of Object.entries(addition)) {
      merged[key] = key in base ? mergeJson(base[key], value) : value
    }

    return merged
  }

  return addition
}
