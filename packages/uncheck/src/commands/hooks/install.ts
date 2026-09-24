import { isDeepStrictEqual } from 'node:util'

import { Console, Effect, FileSystem, Path, Predicate, Stdio } from 'effect'
import { Argument, Command, Prompt } from 'effect/unstable/cli'
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser'

import { userError } from '../../errors'
import { readTextIfExists } from '../../files'
import { gitLocation } from '../../git'
import { detectExec, invokes } from '../../pm'
import { bold, dim, green } from '../../style'
import { cwdFlag, selectionArgs, selectionFlags, validateSelection } from '../uncheck'

// Copilot (30 s) and CodeBuddy (60 s) kill a typecheck at their default timeout and end the turn as
// if no hook ran.
const TIMEOUT_SECONDS = 600

const CLAUDE_FORMAT = {
  event: 'Stop',
  timeout: 'timeout',
  root: {},
  entry: (command: string) => ({ type: 'command', command }),
  group: (entry: object) => ({ hooks: [entry] }),
}

const AGENTS = [
  { id: 'claude', name: 'Claude Code', path: '.claude/settings.json', ...CLAUDE_FORMAT },
  { id: 'codebuddy', name: 'CodeBuddy', path: '.codebuddy/settings.json', ...CLAUDE_FORMAT },
  {
    id: 'cursor',
    name: 'Cursor',
    path: '.cursor/hooks.json',
    event: 'stop',
    timeout: 'timeout',
    root: { version: 1 },
    entry: (command: string) => ({ command }),
    group: (entry: object) => entry,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    path: '.github/hooks/uncheck.json',
    event: 'agentStop',
    timeout: 'timeoutSec',
    root: { version: 1 },
    entry: (command: string) => ({ type: 'command', bash: command, powershell: command }),
    group: (entry: object) => entry,
  },
] as const

const AGENT_IDS = AGENTS.map((agent) => agent.id)

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
    const dir = yield* gitLocation(cwd).pipe(
      Effect.map(({ prefix }) => prefix.replace(/\/$/, '')),
      Effect.orElseSucceed(() => ''),
    )
    const exec = yield* detectExec(cwd, { fromAnyWorkspace: dir === '' })
    const flags = ['--fix', ...selectionArgs(selection), ...(dir === '' ? [] : [`--dir=${dir}`])]
    const command = `${exec} ${HOOK_COMMAND} ${flags.join(' ')}`

    // A reinstall that cannot recognise the command would add a second hook next to it.
    if (!invokes(command, HOOK_COMMAND)) {
      return yield* userError(
        `The hook command cannot name ${dir}: install from the top of the repository or from a directory whose path has only letters, digits and _=./@+-`,
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

    if (dir !== '' && selected.includes('copilot')) {
      return yield* userError(
        `Copilot reads .github/hooks only at the top of the repository, not in ${dir}: install copilot from there`,
      )
    }

    const updates = yield* Effect.forEach(
      AGENTS.filter((agent) => selected.includes(agent.id)),
      (agent) =>
        Effect.gen(function* () {
          const file = path.join(cwd, agent.path)
          const existing = yield* readTextIfExists(file)
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
          const hooks = Predicate.isObject(base.hooks) ? base.hooks : {}
          const entry = agent.entry(command)
          const timeout = { [agent.timeout]: TIMEOUT_SECONDS }
          const entries = hooks[agent.event]
          const found: object[] = []
          // Copilot takes `timeout` as another name for `timeoutSec`, so either is one the user chose.
          const replaced = mapOwnEntries(entries, (hook) => {
            found.push(hook)
            return {
              ...hook,
              ...entry,
              ...('timeout' in hook || 'timeoutSec' in hook ? {} : timeout),
            }
          })
          const next = {
            ...base,
            ...(found.length > 0 ? {} : agent.root),
            hooks: {
              ...hooks,
              [agent.event]:
                found.length > 0
                  ? replaced
                  : [
                      ...(Array.isArray(entries) ? entries : []),
                      agent.group({ ...entry, ...timeout }),
                    ],
            },
          }
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
