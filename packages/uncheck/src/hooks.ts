import type { PlatformError } from 'effect'
import { Effect, FileSystem, Option, Path, Stdio } from 'effect'
import { Argument, CliError, Command, Prompt } from 'effect/unstable/cli'
import { parse as parseJsonc } from 'jsonc-parser'
import { UncheckOptions } from './options'
import { makeUi } from './ui'

export const HOOK_AGENTS = ['claude', 'codebuddy', 'cursor', 'windsurf', 'copilot'] as const

export type HookAgent = (typeof HOOK_AGENTS)[number]

export interface HookIntegration {
  readonly id: HookAgent
  readonly name: string
  /** Config file the agent reads, relative to the project root. */
  readonly path: string
  /** Hook config to write, or to merge into the existing file. */
  readonly content: (command: string) => Record<string, unknown>
}

function claudeStyle(command: string): Record<string, unknown> {
  return {
    hooks: {
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command }] }],
    },
  }
}

export const HOOK_INTEGRATIONS: ReadonlyArray<HookIntegration> = [
  { id: 'claude', name: 'Claude Code', path: '.claude/settings.json', content: claudeStyle },
  { id: 'codebuddy', name: 'CodeBuddy', path: '.codebuddy/settings.json', content: claudeStyle },
  {
    id: 'cursor',
    name: 'Cursor',
    path: '.cursor/hooks.json',
    content: command => ({ version: 1, hooks: { afterFileEdit: [{ command }] } }),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    path: '.windsurf/hooks.json',
    content: command => ({ hooks: { post_write_code: [{ command, show_output: true }] } }),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    path: '.github/hooks/uncheck.json',
    content: command => ({
      version: 1,
      hooks: { postToolUse: [{ type: 'command', bash: command, powershell: command }] },
    }),
  },
]

export const hooksCommand = Command.make(
  'hooks',
  {
    agents: Argument.Literals('agents', HOOK_AGENTS).pipe(
      Argument.variadic(),
      Argument.withDescription(`Agents to configure: ${HOOK_AGENTS.join(', ')}. Prompts for a selection when omitted.`),
    ),
  },
  ({ agents }) =>
    Effect.gen(function* () {
      const options = yield* UncheckOptions
      const ui = yield* makeUi
      const selected = agents.length > 0 ? agents : yield* promptAgents
      const command = yield* hookCommand(options.cwd)

      for (const integration of HOOK_INTEGRATIONS) {
        if (!selected.includes(integration.id)) {
          continue
        }

        const result = yield* installHook(integration, command, options.cwd)

        yield* ui.line(`${ui.green('✔')} ${ui.bold(integration.name)} ${ui.dim(`${integration.path} ${result}`)}`)
      }

      yield* ui.line('')
      yield* ui.line(`${ui.dim('The hooks run')} ${ui.bold(command)} ${ui.dim('after every file the agent edits.')}`)
    }),
).pipe(
  Command.withDescription(
    'Set up agent hooks that run `uncheck --fix` on every file an AI agent edits and hand remaining problems back to it',
  ),
)

const promptAgents = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio

  if (!(yield* stdio.stdinIsTerminal)) {
    const userMessage = `Pass the agents to configure, for example: uncheck hooks ${HOOK_AGENTS.join(' ')}`
    return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
  }

  return yield* Prompt.run(
    Prompt.MultiSelect({
      message: 'Which agents should run uncheck after editing files?',
      choices: HOOK_INTEGRATIONS.map(integration => ({ title: integration.name, value: integration.id })),
      min: 1,
    }),
  )
})

const PACKAGE_MANAGER_EXEC: Record<string, string> = {
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  bun: 'bunx',
  npm: 'npx',
}

const LOCKFILES: ReadonlyArray<readonly [file: string, packageManager: string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/** The hook command, invoking the project's own `uncheck` through the package manager in use. */
export function hookCommand(cwd: string): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const exec = yield* detectPackageManager(cwd)

    return `${PACKAGE_MANAGER_EXEC[exec] ?? PACKAGE_MANAGER_EXEC.npm} uncheck --fix --hook`
  })
}

function detectPackageManager(cwd: string): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    let dir = path.resolve(cwd)

    while (true) {
      const manifest = yield* fs.readFileString(path.join(dir, 'package.json')).pipe(
        Effect.map(text => JSON.parse(text) as { packageManager?: string }),
        Effect.orElseSucceed(() => undefined),
      )

      const declared = manifest?.packageManager?.split('@')[0]

      if (declared !== undefined && declared in PACKAGE_MANAGER_EXEC) {
        return declared
      }

      for (const [file, packageManager] of LOCKFILES) {
        if (yield* fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false))) {
          return packageManager
        }
      }

      const parent = path.dirname(dir)

      if (parent === dir) {
        return 'npm'
      }

      dir = parent
    }
  })
}

export type HookInstallResult = 'created' | 'updated' | 'unchanged'

/**
 * Writes the agent's hook config, merging into an existing file so other hooks are kept.
 * A file that already mentions `uncheck` is left alone, which makes reruns safe.
 */
export function installHook(
  integration: HookIntegration,
  command: string,
  cwd: string,
): Effect.Effect<HookInstallResult, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
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
    const merged = mergeJson(isRecord(current) ? current : {}, addition)

    yield* fs.writeFileString(file, `${JSON.stringify(merged, null, 2)}\n`)

    return 'updated'
  })
}

/** Deep-merges plain objects and concatenates arrays, so hook lists grow instead of being replaced. */
function mergeJson(base: unknown, addition: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(addition)) {
    return [...base, ...addition]
  }

  if (isRecord(base) && isRecord(addition)) {
    const merged: Record<string, unknown> = { ...base }

    for (const [key, value] of Object.entries(addition)) {
      merged[key] = key in base ? mergeJson(base[key], value) : value
    }

    return merged
  }

  return addition
}

const PATH_KEYS = new Set(['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path'])

/**
 * Every file path mentioned in an agent hook payload. The agents disagree on the envelope
 * (`tool_input`, `tool_info`, `toolArgs`, or the top level) but all name the edited file with
 * one of a few keys, so the payload is searched recursively instead of per agent.
 */
export function extractHookPaths(payload: unknown): string[] {
  const found = new Set<string>()

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    if (!isRecord(value)) {
      return
    }

    for (const [key, child] of Object.entries(value)) {
      if (PATH_KEYS.has(key) && typeof child === 'string') {
        found.add(child)
      } else {
        visit(child)
      }
    }
  }

  visit(payload)

  return [...found]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
