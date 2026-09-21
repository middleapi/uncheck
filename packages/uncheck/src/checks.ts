import type { PlatformError } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import type { Step, StepName, StepOutcome, StepPlan } from './step'
import { Data, Duration, Effect, Option, Path } from 'effect'
import { CliError, Flag } from 'effect/unstable/cli'
import { execCommand } from './exec'
import { listProjectFiles, resolvePaths } from './files'
import { UncheckOptions } from './options'
import { describeArgs } from './step'
import { oxfmt } from './steps/oxfmt'
import { oxlint } from './steps/oxlint'
import { tsc } from './steps/tsc'
import { bold, dim, green, line, red } from './ui'

/** Every step uncheck knows, in run order. A new tool is one file in `steps/` plus an entry here. */
const STEPS: ReadonlyArray<Step> = [oxlint, oxfmt, tsc]

export class CheckFailed extends Data.TaggedError('CheckFailed')<{
  readonly outcomes: ReadonlyArray<StepOutcome>
}> {}

/**
 * Per-step switch from the `--oxlint`, `--oxfmt` and `--tsc` flags: `undefined` auto-detects,
 * `false` skips the step, `true` requires it and fails when it cannot run.
 */
export type StepFlags = Readonly<Record<StepName, boolean | undefined>>

export interface RunSettings {
  readonly fix: boolean
  readonly flags: StepFlags
  /** Run with whatever matched instead of failing when a given path or pattern matches no file. */
  readonly allowUnmatched: boolean
}

export const fixFlag = Flag.Boolean('fix').pipe(
  Flag.withDescription('Apply lint fixes (oxlint --fix) and rewrite formatting (oxfmt) instead of only reporting'),
  Flag.withDefault(false),
)

function stepFlag(step: Step) {
  return Flag.Boolean(step.name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined),
    Flag.withDescription(
      `${step.does}. On by default when ${step.when}; --${step.name}=false skips it, --${step.name} requires it`,
    ),
  )
}

/** One optional boolean flag per step, spread into a command's config. */
export const stepFlags = Object.fromEntries(STEPS.map(step => [step.name, stepFlag(step)])) as Record<
  StepName,
  ReturnType<typeof stepFlag>
>

/**
 * Runs every step over `paths` (the whole project when empty), prints the run log and fails with
 * `CheckFailed` when a step failed, so callers decide how to report it.
 */
export function runChecks(paths: ReadonlyArray<string>, { fix, flags, allowUnmatched }: RunSettings) {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const cwd = path.resolve((yield* UncheckOptions).cwd)
    const projectFiles = yield* Effect.cached(listProjectFiles(cwd))

    yield* line(dim(`uncheck in ${cwd}`))

    let files: ReadonlyArray<string> | undefined

    if (paths.length > 0) {
      const resolved = yield* resolvePaths(paths, cwd, projectFiles)

      if (resolved.unmatched.length > 0 && !allowUnmatched) {
        const userMessage = `No files match ${resolved.unmatched.join(', ')}. Pass --no-error-on-unmatched-pattern to run with whatever matched.`
        return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
      }

      if (resolved.files.length === 0) {
        yield* line(`${dim('○')} nothing to check, no files match ${paths.join(' ')}`)
        return
      }

      files = resolved.files
    }

    const plans = yield* Effect.all(
      STEPS.map(step =>
        flags[step.name] === false
          ? Effect.succeed(disabledPlan(step.name))
          : step.plan({ cwd, fix, files, required: flags[step.name] === true, projectFiles }),
      ),
      { concurrency: 'unbounded' },
    )

    const outcomes = yield* Effect.forEach(plans, plan => runStep(plan, cwd))

    const ran = outcomes.filter(outcome => outcome.status !== 'skipped')
    const failed = outcomes.filter(outcome => outcome.status === 'failed')

    yield* line('')

    if (ran.length === 0) {
      const reasons = outcomes.map(outcome => `${outcome.name} ${outcome.reason}`).join(', ')

      yield* line(`${red('✘')} nothing to check: ${reasons}`)
      return yield* Effect.fail(new CheckFailed({ outcomes }))
    }

    if (failed.length > 0) {
      yield* line(
        `${red('✘')} ${failed.length} of ${ran.length} checks failed: ${failed.map(outcome => outcome.name).join(', ')}`,
      )

      if (!fix && failed.some(outcome => STEPS.find(step => step.name === outcome.name)?.fixes)) {
        yield* line(dim('  run `uncheck --fix` to apply oxlint and oxfmt fixes'))
      }

      return yield* Effect.fail(new CheckFailed({ outcomes }))
    }

    yield* line(`${green('✔')} all checks passed (${ran.map(outcome => outcome.name).join(', ')})`)
  })
}

function disabledPlan(name: StepName): StepPlan {
  return { name, status: 'skipped', reason: `disabled with --${name}=false` }
}

function runStep(
  plan: StepPlan,
  cwd: string,
): Effect.Effect<StepOutcome, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    if (plan.status !== 'run') {
      yield* line(
        plan.status === 'skipped'
          ? `${dim('○')} ${bold(plan.name)} ${dim(`skipped, ${plan.reason}`)}`
          : `${red('✘')} ${bold(plan.name)} ${red(plan.reason)}`,
      )
      return plan
    }

    const [duration, exitCodes] = yield* Effect.timed(
      Effect.forEach(plan.commands, invocation =>
        line(`${dim('▶')} ${bold(invocation.bin.name)} ${dim(describeArgs(invocation))}`.trimEnd()).pipe(
          Effect.flatMap(() => execCommand(invocation, cwd)),
        ),
      ),
    )

    const failed = exitCodes.some(exitCode => exitCode !== 0)
    const elapsed = dim(formatDuration(Duration.toMillis(duration)))

    yield* line(
      failed
        ? `${red('✘')} ${bold(plan.name)} ${red('failed')} ${elapsed}`
        : `${green('✔')} ${bold(plan.name)} ${green('passed')} ${elapsed}`,
    )

    return { name: plan.name, status: failed ? 'failed' : 'passed' } satisfies StepOutcome
  })
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
