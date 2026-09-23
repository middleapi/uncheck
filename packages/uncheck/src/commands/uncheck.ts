import path from 'node:path'
import process from 'node:process'

import { Console, Duration, Effect } from 'effect'
import type { CliError } from 'effect/unstable/cli'
import { Argument, Command, Flag } from 'effect/unstable/cli'

import { oxfmt } from '../checks/oxfmt'
import { oxlint } from '../checks/oxlint'
import { sherif } from '../checks/sherif'
import { tsc } from '../checks/tsc'
import { CheckFailed, userError } from '../errors'
import { listProjectFiles, resolvePaths } from '../files'
import { bold, dim, green, listFiles, red } from '../style'
import { execute } from '../tool'
import type { Check, CheckCommand, CheckName, CheckOutcome } from '../types'

const CHECKS: ReadonlyArray<Check> = [sherif, oxlint, oxfmt, tsc]

export const cwdFlag = Flag.Directory('cwd', { mustExist: true }).pipe(
  Flag.withDefault(Effect.sync(() => process.cwd())),
  Flag.withDescription('Directory to run in. Defaults to the current one'),
)

export const fixFlag = Flag.Boolean('fix').pipe(
  Flag.withDescription(
    'Apply workspace fixes (sherif --fix), lint fixes (oxlint --fix) and rewrite formatting (oxfmt) instead of only reporting',
  ),
  Flag.withDefault(false),
)

const CHECK_NAMES = CHECKS.map((check) => check.name)

export const requireFlag = Flag.Literals('require', CHECK_NAMES).pipe(
  Flag.atLeast(0),
  Flag.withDescription(
    'Require a check: fail when it cannot run instead of skipping it. Repeatable',
  ),
)

export const skipFlag = Flag.Literals('skip', CHECK_NAMES).pipe(
  Flag.atLeast(0),
  Flag.withDescription('Skip a check even when it could run. Repeatable'),
)

export const onlyFlag = Flag.Literals('only', CHECK_NAMES).pipe(
  Flag.atLeast(0),
  Flag.withDescription(
    'Run only this check and skip the others, for example the fast ones in a hook. Repeatable',
  ),
)

export interface CheckSelection {
  readonly only: ReadonlyArray<CheckName>
  readonly required: ReadonlyArray<CheckName>
  readonly skipped: ReadonlyArray<CheckName>
}

export interface RunSettings extends CheckSelection {
  readonly cwd: string
  readonly fix: boolean
  readonly allowUnmatched: boolean
}

export function selectionArgs({ only, required, skipped }: CheckSelection): ReadonlyArray<string> {
  return [
    ...only.map((name) => `--only=${name}`),
    ...required.map((name) => `--require=${name}`),
    ...skipped.map((name) => `--skip=${name}`),
  ]
}

export function validateSelection({
  only,
  required,
  skipped,
}: CheckSelection): Effect.Effect<void, CliError.UserError> {
  const requiredButSkipped = required.find((name) => skipped.includes(name))

  if (requiredButSkipped !== undefined) {
    return userError(
      `--require=${requiredButSkipped} and --skip=${requiredButSkipped} contradict each other.`,
    )
  }

  const onlyButSkipped = only.find((name) => skipped.includes(name))

  if (onlyButSkipped !== undefined) {
    return userError(`--only=${onlyButSkipped} and --skip=${onlyButSkipped} contradict each other.`)
  }

  const requiredButNotOnly =
    only.length > 0 ? required.find((name) => !only.includes(name)) : undefined

  if (requiredButNotOnly !== undefined) {
    const onlyFlags = only.map((name) => `--only=${name}`).join(' ')

    return userError(`--require=${requiredButNotOnly} and ${onlyFlags} contradict each other.`)
  }

  return Effect.void
}

type CheckPlan =
  | {
      readonly name: CheckName
      readonly status: 'run'
      readonly commands: ReadonlyArray<CheckCommand>
    }
  | (CheckOutcome & { readonly status: 'skipped' | 'failed'; readonly reason: string })

/** Validates the selection, says where it runs, then runs the checks on `paths`. */
export const runChecks = Effect.fn(function* (paths: ReadonlyArray<string>, settings: RunSettings) {
  yield* validateSelection(settings)

  const cwd = path.resolve(settings.cwd)

  yield* Console.log(dim(`uncheck in ${cwd}`))

  return yield* checkPaths(paths, { ...settings, cwd })
})

/** The checks behind `runChecks`, for commands that validate and introduce themselves first. */
export const checkPaths = Effect.fn(function* (
  paths: ReadonlyArray<string>,
  settings: RunSettings,
) {
  const { fix, only, required, skipped, allowUnmatched } = settings
  const cwd = path.resolve(settings.cwd)
  const projectFiles = yield* Effect.cached(listProjectFiles(cwd))

  let files: ReadonlyArray<string> | undefined

  if (paths.length > 0) {
    const resolved = yield* resolvePaths(paths, cwd, projectFiles)

    if (resolved.unmatched.length > 0 && !allowUnmatched) {
      return yield* userError(
        `No files match ${resolved.unmatched.join(', ')}. Pass --no-error-on-unmatched-pattern to run with whatever matched.`,
      )
    }

    if (resolved.files.length === 0) {
      yield* Console.log(`${dim('○')} nothing to check, no files match ${paths.join(' ')}`)
      return
    }

    files = resolved.files
  }

  const plans = yield* Effect.all(
    CHECKS.map(({ name, plan }) => {
      const exclusion = skipped.includes(name)
        ? `disabled with --skip=${name}`
        : only.length > 0 && !only.includes(name)
          ? 'not selected by --only'
          : undefined

      if (exclusion !== undefined) {
        return Effect.succeed<CheckPlan>({ name, status: 'skipped', reason: exclusion })
      }

      return plan({ cwd, fix, files, projectFiles }).pipe(
        Effect.map((commands): CheckPlan => ({ name, status: 'run', commands })),
        Effect.catchTag('NothingToCheck', ({ reason }) =>
          Effect.succeed<CheckPlan>({
            name,
            status: required.includes(name) ? 'failed' : 'skipped',
            reason,
          }),
        ),
        Effect.catchTag('CannotCheck', ({ reason }) =>
          Effect.succeed<CheckPlan>({ name, status: 'failed', reason }),
        ),
      )
    }),
    { concurrency: 'unbounded' },
  )

  const outcomes = yield* Effect.forEach(plans, (plan) => runCheck(plan, cwd))

  const ran = outcomes.filter((outcome) => outcome.status !== 'skipped')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')

  yield* Console.log('')

  if (ran.length === 0) {
    const reasons = outcomes.map((outcome) => `${outcome.name} ${outcome.reason}`).join(', ')

    yield* Console.log(`${red('✘')} nothing to check: ${reasons}`)
    return yield* Effect.fail(new CheckFailed({ outcomes }))
  }

  if (failed.length > 0) {
    yield* Console.log(
      `${red('✘')} ${failed.length} of ${ran.length} checks failed: ${failed.map((outcome) => outcome.name).join(', ')}`,
    )

    const fixable = failed
      .filter(
        (outcome) =>
          outcome.reason === undefined &&
          CHECKS.find((check) => check.name === outcome.name)?.fixes,
      )
      .map((outcome) => outcome.name)
      .join(', ')
      .replace(/, ([^,]+)$/, ' and $1')

    if (!fix && fixable !== '') {
      yield* Console.log(dim(`  run \`uncheck --fix\` to apply ${fixable} fixes`))
    }

    return yield* Effect.fail(new CheckFailed({ outcomes }))
  }

  yield* Console.log(
    `${green('✔')} all checks passed (${ran.map((outcome) => outcome.name).join(', ')})`,
  )
})

const runCheck = Effect.fn(function* (plan: CheckPlan, cwd: string) {
  if (plan.status !== 'run') {
    yield* Console.log(
      plan.status === 'skipped'
        ? `${dim('○')} ${bold(plan.name)} ${dim(`skipped, ${plan.reason}`)}`
        : `${red('✘')} ${bold(plan.name)} ${red(plan.reason)}`,
    )
    return plan
  }

  const [duration, exitCodes] = yield* Effect.timed(
    Effect.forEach(plan.commands, (invocation) => {
      const { bin, args, files } = invocation
      const shown = files === undefined ? args : [...args, listFiles(files)]

      return Console.log(`${dim('▶')} ${bold(bin.name)} ${dim(shown.join(' '))}`.trimEnd()).pipe(
        Effect.flatMap(() => execute(invocation, cwd)),
      )
    }),
  )

  const failed = exitCodes.some((exitCode) => exitCode !== 0)
  const ms = Duration.toMillis(duration)
  const elapsed = dim(ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

  yield* Console.log(
    failed
      ? `${red('✘')} ${bold(plan.name)} ${red('failed')} ${elapsed}`
      : `${green('✔')} ${bold(plan.name)} ${green('passed')} ${elapsed}`,
  )

  const outcome: CheckOutcome = { name: plan.name, status: failed ? 'failed' : 'passed' }

  return outcome
})

export const uncheck = Command.make(
  'uncheck',
  {
    cwd: cwdFlag,
    fix: fixFlag,
    allowUnmatched: Flag.Boolean('no-error-on-unmatched-pattern').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'Run with whatever matched instead of failing when a given path or pattern matches no file',
      ),
    ),
    only: onlyFlag,
    required: requireFlag,
    skipped: skipFlag,
    paths: Argument.String('paths').pipe(
      Argument.variadic(),
      Argument.withDescription(
        'Files, directories or glob patterns, `!pattern` excludes. uncheck resolves them to one file list that every tool checks, so tools never disagree on what a pattern means. Defaults to everything under the current directory.',
      ),
    ),
  },
  ({ paths, ...settings }) => runChecks(paths, settings),
).pipe(
  Command.withDescription(
    'Check a workspace (sherif), lint (oxlint), format check (oxfmt) and typecheck (tsc) a project with one command. Each check runs only when the project uses that tool.',
  ),
)
