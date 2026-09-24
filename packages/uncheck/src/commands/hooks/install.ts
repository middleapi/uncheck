import { Console, Effect, FileSystem, Option, Path, Predicate, Stdio } from 'effect'
import { Argument, Command, Prompt } from 'effect/unstable/cli'
import { parse as parseJsonc } from 'jsonc-parser'

import { userError } from '../../errors'
import { detectExec } from '../../pm'
import { bold, dim, green } from '../../style'
import { cwdFlag, selectionArgs, selectionFlags, validateSelection } from '../uncheck'

const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    path: '.claude/settings.json',
    content: (command: string) => ({
      hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] },
    }),
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    path: '.codebuddy/settings.json',
    content: (command: string) => ({
      hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] },
    }),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    path: '.cursor/hooks.json',
    content: (command: string) => ({ version: 1, hooks: { stop: [{ command }] } }),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    path: '.windsurf/hooks.json',
    content: (command: string) => ({
      hooks: { post_cascade_response: [{ command, show_output: true }] },
    }),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    path: '.github/hooks/uncheck.json',
    content: (command: string) => ({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: command, powershell: command }] },
    }),
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
    const command = `${exec} ${HOOK_COMMAND} ${['--fix', ...selectionArgs(selection)].join(' ')}`

    for (const agent of AGENTS) {
      if (!selected.includes(agent.id)) {
        continue
      }

      const file = path.join(cwd, agent.path)
      const existing = yield* fs.readFileString(file).pipe(Effect.option)
      let result: 'created' | 'updated' | 'unchanged'

      if (Option.isNone(existing)) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, render(agent.content(command)))
        result = 'created'
      } else {
        const current: unknown = parseJsonc(existing.value, undefined, { allowTrailingComma: true })
        const base = Predicate.isObject(current) ? current : {}
        const installed: string[] = []

        const replaced = mapStrings(base, (text) => {
          if (!text.includes(HOOK_COMMAND)) {
            return text
          }

          installed.push(text)
          return command
        })

        if (installed.length === 0) {
          yield* fs.writeFileString(file, render(mergeJson(base, agent.content(command))))
          result = 'updated'
        } else if (installed.every((text) => text === command)) {
          result = 'unchanged'
        } else {
          yield* fs.writeFileString(file, render(replaced))
          result = 'updated'
        }
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

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function mapStrings(value: unknown, f: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return f(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, f))
  }

  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, f)]),
    )
  }

  return value
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
