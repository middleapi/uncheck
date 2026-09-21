import { stripVTControlCharacters } from 'node:util'
import { Console, Effect, Predicate, Stdio, Stream } from 'effect'
import { Command } from 'effect/unstable/cli'
import { listChangedFiles } from '../../files'
import { StopBlocked, userError } from '../../errors'
import { cwdFlag, fixFlag, onlyFlag, requireFlag, runChecks, skipFlag } from '../uncheck'

export const run = Command.make(
  'run',
  { cwd: cwdFlag, fix: fixFlag, only: onlyFlag, required: requireFlag, skipped: skipFlag },
  Effect.fn(function* ({ cwd, ...settings }) {
    const stdio = yield* Stdio.Stdio

    if (yield* stdio.stdinIsTerminal) {
      return yield* userError('`uncheck hooks run` expects the agent hook payload as JSON on stdin')
    }

    const payload = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
      Effect.flatMap(text => Effect.try((): unknown => JSON.parse(text))),
      Effect.map(value => (Predicate.isObject(value) ? value : {})),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    )

    const changed = yield* listChangedFiles(cwd)

    if (changed?.length === 0) {
      return
    }

    const lines: string[] = []

    const capture: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...parts: ReadonlyArray<unknown>) => {
        lines.push(parts.join(' '))
      },
    })

    const failed = yield* runChecks(changed ?? [], { ...settings, cwd, allowUnmatched: true }).pipe(
      Effect.map(() => false),
      Effect.catchTag('CheckFailed', () => Effect.succeed(true)),
      Effect.provideService(Console.Console, capture),
    )

    const report = stripVTControlCharacters(lines.join('\n'))

    yield* Console.error(report)

    // Send the agent back at most once per turn, in the way its family understands. Claude Code and
    // CodeBuddy block on exit code 2 with stderr as the message and set `stop_hook_active` once they
    // are already continuing; Cursor continues on a follow-up message and counts them in `loop_count`;
    // Copilot continues on a block decision and also sets `stop_hook_active`. Windsurf only shows the report.
    const alreadyContinued =
      payload.stop_hook_active === true || (typeof payload.loop_count === 'number' && payload.loop_count > 0)

    if (!failed || alreadyContinued) {
      return
    }

    const reason = `uncheck found problems, fix them before finishing:\n\n${report}`

    if (payload.hook_event_name === 'Stop') {
      return yield* Effect.fail(new StopBlocked())
    }

    if (payload.hook_event_name === 'stop') {
      return yield* Console.log(JSON.stringify({ followup_message: reason }))
    }

    if (typeof payload.stopReason === 'string') {
      return yield* Console.log(JSON.stringify({ decision: 'block', reason }))
    }
  }),
).pipe(
  Command.withDescription(
    'Run as an agent stop hook: check the files changed since the last commit, report on stderr and send the agent back to fix what remains',
  ),
)
