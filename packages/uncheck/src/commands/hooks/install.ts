import { isDeepStrictEqual } from 'node:util'

import { Console, Effect, FileSystem, Path, Predicate, Stdio } from 'effect'
import { Argument, Command, Prompt } from 'effect/unstable/cli'
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser'

import { userError } from '../../errors'
import { git } from '../../git'
import { detectExec, invokes } from '../../pm'
import { bold, dim, green } from '../../style'
import { cwdFlag, selectionArgs, selectionFlags, validateSelection } from '../uncheck'

// Copilot (30 s) and CodeBuddy (60 s) kill a typecheck at their default timeout and end the turn as
// if no hook ran.
const TIMEOUT_SECONDS = 600

const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    path: '.claude/settings.json',
    entry: (command: string) => ({ type: 'command', command, timeout: TIMEOUT_SECONDS }),
    content: (entry: object) => ({ hooks: { Stop: [{ hooks: [entry] }] } }),
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    path: '.codebuddy/settings.json',
    entry: (command: string) => ({ type: 'command', command, timeout: TIMEOUT_SECONDS }),
    content: (entry: object) => ({ hooks: { Stop: [{ hooks: [entry] }] } }),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    path: '.cursor/hooks.json',
    entry: (command: string) => ({ command, timeout: TIMEOUT_SECONDS }),
    content: (entry: object) => ({ version: 1, hooks: { stop: [entry] } }),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    path: '.github/hooks/uncheck.json',
    entry: (command: string) => ({
      type: 'command',
      bash: command,
      powershell: command,
      timeoutSec: TIMEOUT_SECONDS,
    }),
    content: (entry: object) => ({ version: 1, hooks: { agentStop: [entry] } }),
  },
] as const

const AGENT_IDS = AGENTS.map((agent) => agent.id)

// Must stay within what `invokes` accepts in a flag, or a reinstall adds a second hook.
const FLAG_VALUE = /^[\w./@+-]*$/

export const install = Command.make(
  'install',
  {
    cwd: cwdFlag,
    ...selectionFlags,
    agents: Argument.Literals('agents', AGENT_IDS).pipe(
      Argument.variadic(),
      Argument.withDescription(
        `Agents to configure: ${AGENT_IDS.join(', ')}. Prompts for a selection when omitted.`,
      ),
    ),
  },
  Effect.fn(function* ({ cwd, agents, ...selection }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio

    yield* validateSelection(selection)

    // Agents run the hook wherever they last `cd`'d, so a project below the top of the repository
    // is named relative to it.
    const dir = (yield* git(cwd, ['rev-parse', '--show-prefix']).pipe(
      Effect.orElseSucceed(() => ''),
    )).replace(/\/$/, '')

    if (!FLAG_VALUE.test(dir)) {
      return yield* userError(
        `The hook command cannot name ${dir}: install from the top of the repository or from a directory whose path has only letters, digits and _./@+-`,
      )
    }

    let selected: ReadonlyArray<(typeof AGENT_IDS)[number]> = agents

    if (selected.length === 0) {
      if (!(yield* stdio.stdinIsTerminal)) {
        return yield* userError(
          `Pass the agents to configure, for example: uncheck hooks install ${AGENT_IDS.join(' ')}`,
        )
      }

      selected = yield* Prompt.run(
        Prompt.MultiSelect({
          message: 'Which agents should run uncheck when they finish a turn?',
          choices: AGENTS.map((agent) => ({ title: agent.name, value: agent.id })),
          min: 1,
        }),
      )
    }

    const exec = yield* detectExec(cwd)
    const flags = ['--fix', ...selectionArgs(selection), ...(dir === '' ? [] : [`--dir=${dir}`])]
    const command = `${exec} ${HOOK_COMMAND} ${flags.join(' ')}`

    const updates = yield* Effect.forEach(
      AGENTS.filter((agent) => selected.includes(agent.id)),
      (agent) =>
        Effect.gen(function* () {
          const file = path.join(cwd, agent.path)
          const existing = yield* fs
            .readFileString(file)
            .pipe(Effect.orElseSucceed(() => undefined))
          const text = existing ?? ''
          const errors: ParseError[] = []
          const current: unknown = parseJsonc(text, errors, { allowTrailingComma: true })

          if (text.trim() !== '' && (errors.length > 0 || !Predicate.isObject(current))) {
            const [error] = errors
            const problem =
              error === undefined
                ? 'is not a JSON object'
                : `has ${printParseErrorCode(error.error)} on line ${text.slice(0, error.offset).split('\n').length}`

            return yield* userError(`${agent.path} ${problem}, fix it and run again`)
          }

          const base = Predicate.isObject(current) ? current : {}
          const entry = agent.entry(command)
          const found: object[] = []
          const replaced = mapOwnEntries(base, (hook) => {
            found.push(hook)
            return { ...hook, ...entry }
          })
          const next = found.length > 0 ? replaced : mergeJson(base, agent.content(entry))
          const result =
            existing === undefined
              ? 'created'
              : isDeepStrictEqual(next, base)
                ? 'unchanged'
                : 'updated'

          return { agent, file, next, result }
        }),
    )

    for (const { agent, file, next, result } of updates) {
      if (result !== 'unchanged') {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, `${JSON.stringify(next, null, 2)}\n`)
      }

      yield* Console.log(`${green('✔')} ${bold(agent.name)} ${dim(`${agent.path} ${result}`)}`)
    }

    yield* Console.log('')
    yield* Console.log(
      `${dim('The hook runs')} ${bold(command)} ${dim('whenever the agent finishes a turn.')}`,
    )
  }),
).pipe(
  Command.withDescription(
    'Write the agent hook configs that run `uncheck hooks run` after every agent turn',
  ),
)

const HOOK_COMMAND = 'uncheck hooks run'

function mapOwnEntries(value: unknown, f: (hook: Record<string, unknown>) => object): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapOwnEntries(item, f))
  }

  if (!Predicate.isObject(value)) {
    return value
  }

  if (
    Object.values(value).some((item) => typeof item === 'string' && invokes(item, HOOK_COMMAND))
  ) {
    return f(value)
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapOwnEntries(item, f)]),
  )
}

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
