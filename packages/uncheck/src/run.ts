import type { Check, CheckCommand, CheckName, CheckOutcome, RunSettings } from './types'
import path from 'node:path'
import process from 'node:process'
import { Console, Duration, Effect, Stream } from 'effect'
import { CliError } from 'effect/unstable/cli'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { listProjectFiles, resolvePaths } from './files'
import { CheckFailed } from './errors'
import { bold, colors, dim, green, red } from './style'
import { oxfmt } from './checks/oxfmt'
import { oxlint } from './checks/oxlint'
import { tsc } from './checks/tsc'

export const CHECKS: ReadonlyArray<Check> = [oxlint, oxfmt, tsc]

type CheckPlan =
  | { readonly name: CheckName; readonly status: 'run'; readonly commands: ReadonlyArray<CheckCommand> }
  | (CheckOutcome & { readonly status: 'skipped' | 'failed'; readonly reason: string })

export const runChecks = Effect.fn(function* (paths: ReadonlyArray<string>, settings: RunSettings) {
  const { fix, required, skipped, allowUnmatched } = settings
  const contradiction = required.find(name => skipped.includes(name))

  if (contradiction !== undefined) {
    const userMessage = `--require=${contradiction} and --skip=${contradiction} contradict each other.`
    return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
  }

  const cwd = path.resolve(settings.cwd)
  const projectFiles = yield* Effect.cached(listProjectFiles(cwd))

  yield* Console.log(dim(`uncheck in ${cwd}`))

  let files: ReadonlyArray<string> | undefined

  if (paths.length > 0) {
    const resolved = yield* resolvePaths(paths, cwd, projectFiles)

    if (resolved.unmatched.length > 0 && !allowUnmatched) {
      const userMessage = `No files match ${resolved.unmatched.join(', ')}. Pass --no-error-on-unmatched-pattern to run with whatever matched.`
      return yield* Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
    }

    if (resolved.files.length === 0) {
      yield* Console.log(`${dim('○')} nothing to check, no files match ${paths.join(' ')}`)
      return
    }

    files = resolved.files
  }

  const plans = yield* Effect.all(
    CHECKS.map(({ name, plan }) =>
      skipped.includes(name)
        ? Effect.succeed<CheckPlan>({ name, status: 'skipped', reason: `disabled with --skip=${name}` })
        : plan({ cwd, fix, files, projectFiles }).pipe(
            Effect.map((commands): CheckPlan => ({ name, status: 'run', commands })),
            Effect.catchTag('NothingToCheck', ({ reason }) =>
              Effect.succeed<CheckPlan>({ name, status: required.includes(name) ? 'failed' : 'skipped', reason }),
            ),
            Effect.catchTag('CannotCheck', ({ reason }) =>
              Effect.succeed<CheckPlan>({ name, status: 'failed', reason }),
            ),
          ),
    ),
    { concurrency: 'unbounded' },
  )

  const outcomes = yield* Effect.forEach(plans, plan => runCheck(plan, cwd))

  const ran = outcomes.filter(outcome => outcome.status !== 'skipped')
  const failed = outcomes.filter(outcome => outcome.status === 'failed')

  yield* Console.log('')

  if (ran.length === 0) {
    const reasons = outcomes.map(outcome => `${outcome.name} ${outcome.reason}`).join(', ')

    yield* Console.log(`${red('✘')} nothing to check: ${reasons}`)
    return yield* Effect.fail(new CheckFailed({ outcomes }))
  }

  if (failed.length > 0) {
    yield* Console.log(
      `${red('✘')} ${failed.length} of ${ran.length} checks failed: ${failed.map(outcome => outcome.name).join(', ')}`,
    )

    if (
      !fix &&
      failed.some(outcome => outcome.reason === undefined && CHECKS.find(check => check.name === outcome.name)?.fixes)
    ) {
      yield* Console.log(dim('  run `uncheck --fix` to apply oxlint and oxfmt fixes'))
    }

    return yield* Effect.fail(new CheckFailed({ outcomes }))
  }

  yield* Console.log(`${green('✔')} all checks passed (${ran.map(outcome => outcome.name).join(', ')})`)
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
    Effect.forEach(plan.commands, invocation => {
      const { bin, args, files } = invocation
      const tail = files === undefined ? [] : files.length <= 3 ? files : [`[${files.length} files]`]

      return Console.log(`${dim('▶')} ${bold(bin.name)} ${dim([...args, ...tail].join(' '))}`.trimEnd()).pipe(
        Effect.flatMap(() => execute(invocation, cwd)),
      )
    }),
  )

  const failed = exitCodes.some(exitCode => exitCode !== 0)
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

/** Output goes through `Console` so it stays in order with uncheck's own lines and can be captured in hook mode. */
const execute = Effect.fn(function* ({ bin, args, files = [] }: CheckCommand, cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [bin.entry, ...args, ...files], {
      cwd,
      stdin: 'ignore',
      // A piped tool cannot see the terminal, so tell it when colors are wanted.
      env: colors ? { FORCE_COLOR: '1' } : {},
      extendEnv: true,
    }),
  )

  yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.all)), text => Console.log(text))

  return yield* handle.exitCode
}, Effect.scoped)
