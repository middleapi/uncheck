import { Console, Effect, FileSystem, Option, Path, Predicate, Stdio } from 'effect'
import { Argument, CliError, Command, Prompt } from 'effect/unstable/cli'
import { parse as parseJsonc } from 'jsonc-parser'
import { ancestors, readJson } from '../../files'
import { bold, dim, green } from '../../style'
import { cwdFlag } from '../uncheck'

const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    path: '.claude/settings.json',
    content: (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    path: '.codebuddy/settings.json',
    content: (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
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
    content: (command: string) => ({ hooks: { post_cascade_response: [{ command, show_output: true }] } }),
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

const AGENT_IDS = AGENTS.map(agent => agent.id)

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

export const install = Command.make(
  'install',
  {
    cwd: cwdFlag,
    agents: Argument.Literals('agents', AGENT_IDS).pipe(
      Argument.variadic(),
      Argument.withDescription(`Agents to configure: ${AGENT_IDS.join(', ')}. Prompts for a selection when omitted.`),
    ),
  },
  Effect.fn(function* ({ cwd, agents }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio

    let selected: ReadonlyArray<(typeof AGENT_IDS)[number]> = agents

    if (selected.length === 0) {
      if (!(yield* stdio.stdinIsTerminal)) {
        const userMessage = `Pass the agents to configure, for example: uncheck hooks install ${AGENT_IDS.join(' ')}`
        return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
      }

      selected = yield* Prompt.run(
        Prompt.MultiSelect({
          message: 'Which agents should run uncheck when they finish a turn?',
          choices: AGENTS.map(agent => ({ title: agent.name, value: agent.id })),
          min: 1,
        }),
      )
    }

    let exec = 'npx'

    for (const dir of ancestors(path, cwd)) {
      const manifest = yield* readJson(path.join(dir, 'package.json'))
      const declared =
        typeof manifest?.packageManager === 'string'
          ? EXEC_BY_PACKAGE_MANAGER[manifest.packageManager.split('@')[0] ?? '']
          : undefined

      const lockfile = yield* Effect.findFirst(EXEC_BY_LOCKFILE, ([file]) =>
        fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
      )

      if (declared !== undefined || Option.isSome(lockfile)) {
        exec = declared ?? Option.getOrThrow(lockfile)[1]
        break
      }
    }

    const command = `${exec} uncheck hooks run --fix`

    for (const agent of AGENTS) {
      if (!selected.includes(agent.id)) {
        continue
      }

      const file = path.join(cwd, agent.path)
      const existing = yield* fs.readFileString(file).pipe(Effect.option)
      let result: 'created' | 'updated' | 'unchanged'

      if (Option.isNone(existing)) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, `${JSON.stringify(agent.content(command), null, 2)}\n`)
        result = 'created'
      } else if (existing.value.includes('uncheck')) {
        result = 'unchanged'
      } else {
        const current: unknown = parseJsonc(existing.value, undefined, { allowTrailingComma: true })
        const merged = mergeJson(Predicate.isObject(current) ? current : {}, agent.content(command))

        yield* fs.writeFileString(file, `${JSON.stringify(merged, null, 2)}\n`)
        result = 'updated'
      }

      yield* Console.log(`${green('✔')} ${bold(agent.name)} ${dim(`${agent.path} ${result}`)}`)
    }

    yield* Console.log('')
    yield* Console.log(`${dim('The hook runs')} ${bold(command)} ${dim('whenever the agent finishes a turn.')}`)
  }),
).pipe(Command.withDescription('Write the agent hook configs that run `uncheck hooks run` after every agent turn'))

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
