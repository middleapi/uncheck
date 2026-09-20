import type { PlatformError } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import type { Tool } from './tools'
import type { Ui } from './ui'
import { stripVTControlCharacters } from 'node:util'
import { Data, Duration, Effect, FileSystem, Option, Path, Stdio, Stream, Terminal } from 'effect'
import { Argument, CliError, Command, Flag } from 'effect/unstable/cli'
import { execTool } from './exec'
import { extractHookPaths, hooksCommand } from './hooks'
import { UncheckOptions } from './options'
import { resolveTool } from './tools'
import { discoverTsconfigs, isWithin, loadTsProjects, planTypecheck, selectTsconfigs } from './typecheck'
import { makeUi } from './ui'

export type StepName = 'oxlint' | 'oxfmt' | 'tsc'

export interface StepOutcome {
  readonly name: StepName
  readonly status: 'passed' | 'failed' | 'skipped'
  /** Why the step was skipped, or why it failed before any tool ran. */
  readonly reason?: string
}

export class CheckFailed extends Data.TaggedError('CheckFailed')<{
  readonly outcomes: ReadonlyArray<StepOutcome>
}> {}

/**
 * Per-step switch from the `--oxlint`, `--oxfmt` and `--tsc` flags: unset auto-detects,
 * `false` skips the step, `true` requires it and fails when it cannot run.
 */
type StepFlags = Readonly<Record<StepName, Option.Option<boolean>>>

interface ToolCommand {
  readonly tool: Tool
  readonly args: ReadonlyArray<string>
}

interface RunPlan {
  readonly name: StepName
  readonly status: 'run'
  readonly commands: ReadonlyArray<ToolCommand>
}

/** A step that is either ready to run, or already settled without running anything. */
type StepPlan = RunPlan | (StepOutcome & { readonly status: 'skipped' | 'failed'; readonly reason: string })

interface ToolStep {
  readonly name: 'oxlint' | 'oxfmt'
  readonly args: (fix: boolean) => ReadonlyArray<string>
}

/** The steps that simply run their tool, in run order. Fixes apply to exactly these. */
const TOOL_STEPS: ReadonlyArray<ToolStep> = [
  { name: 'oxlint', args: fix => (fix ? ['--fix'] : []) },
  { name: 'oxfmt', args: fix => (fix ? [] : ['--check']) },
]

/** Explicit paths may name files a tool does not handle (a Markdown file for oxlint), which is not a failure. */
const UNMATCHED_PATHS_OK = '--no-error-on-unmatched-pattern'

function stepFlag(name: StepName, what: string, when: string) {
  return Flag.Boolean(name).pipe(
    Flag.optional,
    Flag.withDescription(`${what}. On by default when ${when}; --${name}=false skips it, --${name} requires it`),
  )
}

export const command = Command.make(
  'uncheck',
  {
    fix: Flag.Boolean('fix').pipe(
      Flag.withDescription('Apply lint fixes (oxlint --fix) and rewrite formatting (oxfmt) instead of only reporting'),
      Flag.withDefault(false),
    ),
    hook: Flag.Boolean('hook').pipe(
      Flag.withDescription(
        'Run as an agent hook: check the files named in the JSON payload on stdin, report on stderr and hand remaining problems back to the agent. Set up with `uncheck hooks`.',
      ),
      Flag.withDefault(false),
    ),
    oxlint: stepFlag('oxlint', 'Lint with oxlint', 'oxlint is installed'),
    oxfmt: stepFlag('oxfmt', 'Check formatting with oxfmt', 'oxfmt is installed'),
    tsc: stepFlag('tsc', 'Typecheck with tsc', 'a tsconfig.json is found'),
    paths: Argument.String('paths').pipe(
      Argument.variadic(),
      Argument.withDescription(
        'Files, directories or glob patterns, forwarded to oxlint and oxfmt as-is. tsc runs only the projects that take them as input. Defaults to the whole project.',
      ),
    ),
  },
  ({ fix, hook, oxlint, oxfmt, tsc, paths }) =>
    Effect.gen(function* () {
      const flags: StepFlags = { oxlint, oxfmt, tsc }

      if (hook) {
        return yield* runHook(fix, flags)
      }

      yield* runChecks(fix, paths, flags)
    }),
).pipe(
  Command.withDescription(
    'Lint (oxlint), format check (oxfmt) and typecheck (tsc) a project with one command. Each step runs only when the project uses that tool.',
  ),
  Command.withSubcommands([hooksCommand]),
)

function runChecks(fix: boolean, paths: ReadonlyArray<string>, flags: StepFlags) {
  return Effect.gen(function* () {
    const options = yield* UncheckOptions
    const ui = yield* makeUi
    const cwd = options.cwd

    const [toolPlans, typescript, tsconfigs] = yield* Effect.all(
      [
        Effect.forEach(
          TOOL_STEPS,
          step =>
            Effect.map(resolveTool(step.name, cwd), tool => planToolStep(step, tool, flags[step.name], fix, paths)),
          { concurrency: 'unbounded' },
        ),
        resolveTool('typescript', cwd, 'tsc'),
        discoverTsconfigs(cwd),
      ],
      { concurrency: 'unbounded' },
    )

    const plans = [...toolPlans, yield* planTscStep(typescript, tsconfigs, flags.tsc, paths, cwd)]
    const outcomes = yield* Effect.forEach(plans, plan => runStep(ui, options, plan))

    const ran = outcomes.filter(outcome => outcome.status !== 'skipped')
    const failed = outcomes.filter(outcome => outcome.status === 'failed')

    yield* ui.line('')

    if (ran.length === 0) {
      const reasons = outcomes.map(outcome => `${outcome.name} ${outcome.reason}`).join(', ')

      yield* ui.line(`${ui.red('✘')} nothing to check: ${reasons}`)
      return yield* Effect.fail(new CheckFailed({ outcomes }))
    }

    if (failed.length > 0) {
      yield* ui.line(
        `${ui.red('✘')} ${failed.length} of ${ran.length} checks failed: ${failed.map(outcome => outcome.name).join(', ')}`,
      )

      if (!fix && failed.some(outcome => TOOL_STEPS.some(step => step.name === outcome.name))) {
        yield* ui.line(ui.dim('  run `uncheck --fix` to apply oxlint and oxfmt fixes'))
      }

      return yield* Effect.fail(new CheckFailed({ outcomes }))
    }

    yield* ui.line(`${ui.green('✔')} all checks passed (${ran.map(outcome => outcome.name).join(', ')})`)
  })
}

/**
 * Agent hook mode. The payload on stdin names the files the agent just edited; only those inside
 * the project are checked. Output is captured and mirrored to stderr, and when problems remain
 * they are returned on stdout as `additionalContext`, which Claude Code and CodeBuddy show to
 * the agent while every other agent ignores it. The exit code stays 0 so no agent treats a
 * finding as a hook failure.
 */
function runHook(fix: boolean, flags: StepFlags) {
  return Effect.gen(function* () {
    const options = yield* UncheckOptions
    const stdio = yield* Stdio.Stdio
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const terminal = yield* Terminal.Terminal

    if (yield* stdio.stdinIsTerminal) {
      const userMessage = '--hook expects the agent hook payload as JSON on stdin'
      return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
    }

    const cwd = path.resolve(options.cwd)

    const payload = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
      Effect.flatMap(text => Effect.try(() => JSON.parse(text) as unknown)),
      Effect.orElseSucceed(() => undefined),
    )

    const files = yield* Effect.filter(
      extractHookPaths(payload)
        .map(file => path.resolve(cwd, file))
        .filter(file => isWithin(path, file, cwd)),
      file => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
    )

    if (files.length === 0) {
      return
    }

    const chunks: string[] = []

    const capture = Terminal.make({
      columns: terminal.columns,
      rows: terminal.rows,
      readInput: terminal.readInput,
      readLine: terminal.readLine,
      display: text =>
        Effect.sync(() => {
          chunks.push(text)
        }),
    })

    const relativeFiles = files.map(file => path.relative(cwd, file))

    const failed = yield* runChecks(fix, relativeFiles, flags).pipe(
      Effect.map(() => false),
      Effect.catchTag('CheckFailed', () => Effect.succeed(true)),
      Effect.provideService(Terminal.Terminal, capture),
      Effect.provideService(UncheckOptions, { ...options, stdio: 'pipe' }),
    )

    const report = stripVTControlCharacters(chunks.join(''))

    yield* Stream.make(report).pipe(Stream.run(stdio.stderr()))

    if (failed) {
      const additionalContext = `uncheck found problems in ${relativeFiles.join(', ')}, fix them before moving on:\n\n${report}`
      const output = { additionalContext, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }

      yield* Stream.make(`${JSON.stringify(output)}\n`).pipe(Stream.run(stdio.stdout()))
    }
  })
}

function disabled(name: StepName, enabled: Option.Option<boolean>): StepPlan | undefined {
  return Option.isSome(enabled) && !enabled.value
    ? { name, status: 'skipped', reason: `disabled with --${name}=false` }
    : undefined
}

function planToolStep(
  step: ToolStep,
  tool: Option.Option<Tool>,
  enabled: Option.Option<boolean>,
  fix: boolean,
  paths: ReadonlyArray<string>,
): StepPlan {
  const off = disabled(step.name, enabled)

  if (off !== undefined) {
    return off
  }

  if (Option.isNone(tool)) {
    return { name: step.name, status: Option.isSome(enabled) ? 'failed' : 'skipped', reason: 'not installed' }
  }

  return {
    name: step.name,
    status: 'run',
    commands: [
      { tool: tool.value, args: [...step.args(fix), ...(paths.length > 0 ? [UNMATCHED_PATHS_OK] : []), ...paths] },
    ],
  }
}

function planTscStep(
  typescript: Option.Option<Tool>,
  tsconfigs: ReadonlyArray<string>,
  enabled: Option.Option<boolean>,
  paths: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<StepPlan, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const off = disabled('tsc', enabled)

    if (off !== undefined) {
      return off
    }

    const path = yield* Path.Path
    const nothingToCheck = (reason: string): StepPlan => ({
      name: 'tsc',
      status: Option.isSome(enabled) ? 'failed' : 'skipped',
      reason,
    })

    if (tsconfigs.length === 0) {
      return nothingToCheck('no tsconfig.json found')
    }

    const selected = yield* selectTsconfigs(tsconfigs, paths, cwd)

    if (selected.length === 0) {
      return nothingToCheck('no tsconfig.json covers the given paths')
    }

    if (Option.isNone(typescript)) {
      return {
        name: 'tsc',
        status: 'failed',
        reason: `found ${selected.length} tsconfig.json but typescript is not installed`,
      }
    }

    const tool = typescript.value
    const relative = (configPath: string) => path.relative(cwd, configPath) || '.'

    const projects = yield* loadTsProjects(selected)

    return yield* planTypecheck(selected, projects).pipe(
      Effect.map((plan): StepPlan => {
        const commands: ToolCommand[] = []

        if (plan.build.length > 0) {
          commands.push({ tool, args: ['-b', ...plan.build.map(relative)] })
        }

        for (const configPath of plan.check) {
          commands.push({ tool, args: ['-p', relative(configPath)] })
        }

        return { name: 'tsc', status: 'run', commands }
      }),
      Effect.catchTag('CircularProjectReferences', error =>
        Effect.succeed<StepPlan>({
          name: 'tsc',
          status: 'failed',
          reason: `circular project references between ${error.projects.map(relative).join(', ')}`,
        }),
      ),
    )
  })
}

function runStep(
  ui: Ui,
  options: UncheckOptions,
  plan: StepPlan,
): Effect.Effect<
  StepOutcome,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | Terminal.Terminal
> {
  return Effect.gen(function* () {
    if (plan.status !== 'run') {
      yield* ui.line(
        plan.status === 'skipped'
          ? `${ui.dim('○')} ${ui.bold(plan.name)} ${ui.dim(`skipped, ${plan.reason}`)}`
          : `${ui.red('✘')} ${ui.bold(plan.name)} ${ui.red(plan.reason)}`,
      )
      return plan
    }

    const [duration, exitCodes] = yield* Effect.timed(
      Effect.forEach(plan.commands, ({ tool, args }) =>
        ui
          .line(`${ui.dim('▶')} ${ui.bold(tool.name)} ${ui.dim(args.join(' '))}`.trimEnd())
          .pipe(Effect.flatMap(() => execTool(tool, args, options))),
      ),
    )

    const failed = exitCodes.some(exitCode => exitCode !== 0)
    const elapsed = ui.dim(formatDuration(Duration.toMillis(duration)))

    yield* ui.line(
      failed
        ? `${ui.red('✘')} ${ui.bold(plan.name)} ${ui.red('failed')} ${elapsed}`
        : `${ui.green('✔')} ${ui.bold(plan.name)} ${ui.green('passed')} ${elapsed}`,
    )

    return { name: plan.name, status: failed ? 'failed' : 'passed' } satisfies StepOutcome
  })
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
