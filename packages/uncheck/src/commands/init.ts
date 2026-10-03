import process from 'node:process'

import { Console, Effect, FileSystem, Option, Path, Predicate, Stdio } from 'effect'
import { Command, Flag, Prompt } from 'effect/unstable/cli'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { userError } from '../errors.ts'
import { ancestors, firstFile, isWorkspaceRoot, readJson } from '../files.ts'
import { detectExec, detectPackageManager } from '../pm.ts'
import { bold, dim, green, listed } from '../style.ts'
import { resolveBin } from '../tool.ts'
import type { AgentId } from './hooks/install.ts'
import {
  AGENTS,
  agentHookCommand,
  agentHookDir,
  chooseAgents,
  hasOwnHook,
  validateAgentHookDir,
  writeAgentHooks,
} from './hooks/install.ts'
import { writePreCommitHook } from './prepare.ts'
import { cwdFlag } from './uncheck.ts'

const NO_SELECTION = { only: [], required: [], skipped: [] }

const TOOLS = [
  { name: 'oxlint', checks: 'lint rules' },
  { name: 'oxfmt', checks: 'formatting' },
  { name: 'sherif', checks: 'monorepo consistency' },
] as const

const PRESETS = [
  {
    tool: 'oxlint',
    summary: "oxlint's defaults plus a few rules that catch real bugs",
    content:
      "import { defineConfig } from 'oxlint'\nimport { middleapi } from 'uncheck/oxlint'\n\nexport default defineConfig({ extends: [middleapi] })\n",
  },
  {
    tool: 'oxfmt',
    summary: 'no semicolons, single quotes and sorted imports',
    content:
      "import { defineConfig } from 'oxfmt'\nimport { middleapi } from 'uncheck/oxfmt'\n\nexport default defineConfig({ ...middleapi })\n",
  },
] as const

const SCRIPTS = { check: 'uncheck', fix: 'uncheck --fix' }

const PREPARE = 'uncheck prepare --pre-commit'

const RUNS_PREPARE = /\buncheck prepare\b/

const INSTALL_ARGS = {
  pnpm: ['add', '--save-dev'],
  yarn: ['add', '--dev'],
  bun: ['add', '--dev'],
  npm: ['install', '--save-dev'],
}

const INDENT = /^[ \t]+(?=")/m

function withPrepare(script: unknown): string {
  return typeof script !== 'string' || script.trim() === '' ? PREPARE : `${script} && ${PREPARE}`
}

const runInstall = Effect.fn(function* (command: ReadonlyArray<string>, cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  yield* Console.log(`${dim('▶')} ${bold(command[0]!)} ${dim(command.slice(1).join(' '))}`)

  // Package managers ask before they replace a node_modules another one installed, so they get the
  // terminal. On Windows they are `.cmd` scripts, which only a shell runs.
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command[0]!, command.slice(1), {
        cwd,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        shell: process.platform === 'win32',
      }),
    )
    .pipe(
      Effect.catchReason('PlatformError', 'NotFound', () =>
        userError(`${command[0]} is not installed, install it and run uncheck init again`),
      ),
    )

  return yield* handle.exitCode
}, Effect.scoped)

export const init = Command.make(
  'init',
  {
    cwd: cwdFlag,
    yes: Flag.Boolean('yes').pipe(
      Flag.withAlias('y'),
      Flag.withDefault(false),
      Flag.withDescription(
        'Take the default answers instead of asking: install the missing tools, check every commit, and run uncheck after the turns of the agents whose folders exist and that do not run it yet',
      ),
    ),
  },
  Effect.fn(function* ({ cwd, yes }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio

    const manifestFile = path.join(cwd, 'package.json')
    const manifest = yield* readJson(manifestFile)

    if (manifest === undefined) {
      return yield* userError(
        (yield* fs.exists(manifestFile))
          ? `${manifestFile} is not a JSON object, fix it and run uncheck init again`
          : `No package.json in ${cwd} to set up: create one first, for example with \`npm init\``,
      )
    }

    if (!yes && !(yield* stdio.stdinIsTerminal)) {
      return yield* userError(
        'Answer the questions in a terminal, or pass --yes to take the default answers',
      )
    }

    yield* Console.log(dim(`uncheck init in ${cwd}`))

    const workspaceRoot = yield* isWorkspaceRoot(cwd, manifest)
    const enclosingWorkspace = workspaceRoot
      ? Option.none()
      : yield* Effect.findFirst(ancestors(path, cwd).slice(1), (dir) =>
          readJson(path.join(dir, 'package.json')).pipe(
            Effect.flatMap((parent) => isWorkspaceRoot(dir, parent ?? {})),
          ),
        )

    if (Option.isSome(enclosingWorkspace)) {
      yield* Console.log(
        `${dim('○')} ${dim(`inside the workspace at ${path.relative(cwd, enclosingWorkspace.value)}, run uncheck init there to set up every package`)}`,
      )
    }

    const packageManager = yield* detectPackageManager(cwd)

    const missing = yield* Effect.filter(
      TOOLS.filter((tool) => tool.name !== 'sherif' || workspaceRoot),
      (tool) => resolveBin(tool.name, cwd).pipe(Effect.map((bin) => bin === undefined)),
    )
    const tools =
      yes || missing.length === 0
        ? missing.map((tool) => tool.name)
        : yield* Prompt.run(
            Prompt.MultiSelect({
              message: 'Which tools should uncheck install?',
              choices: missing.map((tool) => ({
                title: tool.name,
                value: tool.name,
                description: `checks ${tool.checks}`,
                selected: true,
              })),
            }),
          )

    const configurable = yield* Effect.filter(
      PRESETS.filter(
        (preset) =>
          tools.includes(preset.tool) || !missing.some((tool) => tool.name === preset.tool),
      ),
      (preset) =>
        firstFile(
          ancestors(path, cwd).flatMap((dir) =>
            [
              `.${preset.tool}rc.json`,
              `.${preset.tool}rc.jsonc`,
              `${preset.tool}.config.ts`,
              `${preset.tool}.config.mts`,
            ].map((name) => path.join(dir, name)),
          ),
        ).pipe(Effect.map(Option.isNone)),
    )
    const presets =
      yes || configurable.length === 0
        ? []
        : yield* Prompt.run(
            Prompt.MultiSelect({
              message: 'Which tools should get a config from the middleapi preset?',
              choices: configurable.map((preset) => ({
                title: preset.tool,
                value: preset,
                description: preset.summary,
              })),
            }),
          )

    const hookScript = packageManager.yarnBerry ? 'postinstall' : 'prepare'
    const scripts = Predicate.isObject(manifest.scripts) ? manifest.scripts : {}
    const hooked = typeof scripts[hookScript] === 'string' && RUNS_PREPARE.test(scripts[hookScript])
    const preCommit =
      !hooked &&
      (yes ||
        (yield* Prompt.run(
          Prompt.Confirm({ message: 'Check the staged files before every commit?', initial: true }),
        )))

    const dir = yield* agentHookDir(cwd)
    const hookedAgents = yield* Effect.filter(AGENTS, (agent) => hasOwnHook(cwd, agent))
    const offeredAgents = AGENTS.filter(
      (agent) => !hookedAgents.includes(agent) && (dir === '' || agent.id !== 'copilot'),
    )
    const usedAgents = yield* Effect.filter(offeredAgents, (agent) =>
      fs.exists(path.join(cwd, path.dirname(agent.path))),
    )
    const agents: ReadonlyArray<AgentId> =
      yes || offeredAgents.length === 0
        ? usedAgents.map((agent) => agent.id)
        : yield* chooseAgents(offeredAgents, { preselected: usedAgents })

    // A folder the agent hook cannot name would otherwise fail the run after the install.
    yield* agents.length > 0 ? validateAgentHookDir(dir) : Effect.void

    const packages = [
      ...((yield* resolveBin('uncheck', cwd)) === undefined ? ['uncheck'] : []),
      ...tools,
    ]

    if (packages.length > 0) {
      // pnpm and Yarn 1 refuse to add to the root of a workspace unless told that is meant.
      const rootFlags =
        packageManager.name === 'pnpm' && (yield* fs.exists(path.join(cwd, 'pnpm-workspace.yaml')))
          ? ['--workspace-root']
          : packageManager.name === 'yarn' &&
              !packageManager.yarnBerry &&
              manifest.workspaces !== undefined
            ? ['--ignore-workspace-root-check']
            : []
      const command = [
        packageManager.name,
        ...INSTALL_ARGS[packageManager.name],
        ...rootFlags,
        ...packages,
      ]
      const exitCode = yield* runInstall(command, cwd)

      if (exitCode !== 0) {
        return yield* userError(
          `\`${command.join(' ')}\` failed, so nothing else was set up. Run uncheck init again once it installs`,
        )
      }
    }

    for (const preset of presets) {
      const file = `${preset.tool}.config.${manifest.type === 'module' ? 'ts' : 'mts'}`

      yield* fs.writeFileString(path.join(cwd, file), preset.content, { flag: 'wx' })
      yield* Console.log(`${green('✔')} ${bold(preset.tool)} ${dim(`${file} created`)}`)
    }

    // The install rewrote package.json, so the scripts go into what it wrote.
    const text = yield* fs.readFileString(manifestFile)
    const installed: Record<string, unknown> = JSON.parse(text)
    const before = Predicate.isObject(installed.scripts) ? installed.scripts : {}
    const after: Record<string, unknown> = {
      ...before,
      ...Object.fromEntries(Object.entries(SCRIPTS).filter(([name]) => before[name] === undefined)),
      ...(preCommit ? { [hookScript]: withPrepare(before[hookScript]) } : {}),
    }
    const written = Object.keys(after).filter((name) => after[name] !== before[name])

    if (written.length > 0) {
      const indent = INDENT.exec(text)?.[0] ?? '  '

      yield* fs.writeFileString(
        manifestFile,
        `${JSON.stringify({ ...installed, scripts: after }, null, indent)}\n`,
      )
    }

    yield* Console.log(
      `${green('✔')} ${bold('package.json')} ${dim(written.length === 0 ? 'unchanged' : `scripts ${listed(written)} written`)}`,
    )

    if (hooked) {
      yield* Console.log(
        `${dim('○')} ${bold('pre-commit')} ${dim(`left to the ${hookScript} script, which writes it on every install`)}`,
      )
    }

    if (preCommit) {
      yield* writePreCommitHook(cwd, { fix: true, allowEmpty: false, ...NO_SELECTION })

      if (hookScript === 'postinstall' && manifest.private !== true) {
        yield* Console.log(
          `${dim('○')} ${dim('postinstall also runs where this package is installed, turn it off while packing, for example with pinst')}`,
        )
      }
    }

    for (const agent of hookedAgents) {
      yield* Console.log(
        `${dim('○')} ${bold(agent.name)} ${dim(`${agent.path} already runs uncheck`)}`,
      )
    }

    if (agents.length > 0) {
      // Only after the install declares uncheck here does Yarn 2+ run the package's own binary.
      yield* writeAgentHooks(cwd, yield* agentHookCommand(cwd, dir, NO_SELECTION), agents)
    }

    const exec = yield* detectExec(cwd)
    const run = (name: keyof typeof SCRIPTS) =>
      after[name] === SCRIPTS[name]
        ? `${packageManager.name} run ${name}`
        : `${exec} ${SCRIPTS[name]}`

    yield* Console.log('')
    yield* Console.log(
      `${dim('Run')} ${bold(run('check'))} ${dim('to check the project, and')} ${bold(run('fix'))} ${dim('to fix what can be fixed.')}`,
    )
  }),
).pipe(
  Command.withDescription(
    'Set up uncheck in a project: install the tools it runs, add the check and fix scripts, and run it before every commit and after every agent turn',
  ),
)
