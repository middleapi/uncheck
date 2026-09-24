import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'

import { Console, Effect, Option, Path, Predicate, Stdio, Stream } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { StopBlocked, userError } from '../../errors'
import { listChangedFiles } from '../../files'
import { git } from '../../git'
import { captureLines } from '../../tool'
import { fixFlag, runChecks, selectionFlags } from '../uncheck'

export const run = Command.make(
  'run',
  {
    cwd: Flag.Directory('cwd', { mustExist: true }).pipe(
      Flag.optional,
      Flag.withDescription(
        'Directory to check. Defaults to the top of the git repository around the current directory, or the current directory outside git',
      ),
    ),
    dir: Flag.String('dir').pipe(
      Flag.optional,
      Flag.withDescription(
        'Directory to check relative to the top of the git repository, whichever directory the agent moved to. `hooks install` writes it for a project below the top',
      ),
    ),
    fix: fixFlag,
    ...selectionFlags,
  },
  Effect.fn(function* ({ cwd: given, dir, ...settings }) {
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio

    if (yield* stdio.stdinIsTerminal) {
      return yield* userError('`uncheck hooks run` expects the agent hook payload as JSON on stdin')
    }

    const payload = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
      Effect.flatMap((text) => Effect.try((): unknown => JSON.parse(text))),
      Effect.map((value) => (Predicate.isObject(value) ? value : {})),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    )

    const start = Option.getOrElse(given, () => process.cwd())
    const top = yield* git(start, ['rev-parse', '--show-toplevel']).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    const cwd = Option.isSome(dir)
      ? path.join(top ?? start, dir.value)
      : Option.getOrElse(given, () => top ?? start)

    const changed = yield* listChangedFiles(cwd)

    if (changed?.length === 0) {
      return
    }

    const [failed, lines] = yield* runChecks(changed ?? [], {
      ...settings,
      cwd,
      literal: true,
    }).pipe(
      Effect.map(() => false),
      Effect.catchTag('CheckFailed', () => Effect.succeed(true)),
      captureLines,
    )

    const report = stripVTControlCharacters(lines.join('\n'))

    yield* Console.error(report)

    if (!failed) {
      return
    }

    // Send the agent back at most once per turn, in the way its family understands. Claude Code and
    // CodeBuddy block on exit code 2 with stderr as the message, set `stop_hook_active` once they are
    // already continuing, and show the user nothing but a `systemMessage` from a hook that exits 0;
    // Cursor continues on a follow-up message and counts them in `loop_count`; Copilot continues on a
    // block decision, also in the Claude format, where it takes exit code 2 for a mere warning.
    const alreadyContinued =
      payload.stop_hook_active === true ||
      (typeof payload.loop_count === 'number' && payload.loop_count > 0)

    if (alreadyContinued) {
      if (payload.hook_event_name === 'Stop') {
        const summary =
          report
            .split('\n')
            .filter((line) => line.startsWith('✘ '))
            .at(-1) ?? ''

        yield* Console.log(
          JSON.stringify({ systemMessage: `uncheck still fails: ${summary.slice(2)}` }),
        )
      }

      return
    }

    const reason = `uncheck found problems, fix them before finishing:\n\n${report}`

    if (typeof (payload.stopReason ?? payload.stop_reason) === 'string') {
      return yield* Console.log(JSON.stringify({ decision: 'block', reason }))
    }

    if (payload.hook_event_name === 'Stop') {
      return yield* Effect.fail(new StopBlocked())
    }

    if (payload.hook_event_name === 'stop') {
      return yield* Console.log(JSON.stringify({ followup_message: reason }))
    }
  }),
).pipe(
  Command.withDescription(
    'Run as an agent stop hook: check the files changed since the last commit, report on stderr and send the agent back to fix what remains',
  ),
)
