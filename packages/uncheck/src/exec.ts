import type { PlatformError } from 'effect'
import type { StepCommand } from './step'
import process from 'node:process'
import { Console, Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { colors } from './ui'

/**
 * Runs a tool command in `cwd` and resolves with its exit code; a non-zero exit code is a normal
 * result, not a failure. Output is piped and re-emitted line by line through `Console`, so it stays
 * in order with everything else uncheck prints and can be captured in hook mode.
 */
export function execCommand(
  { bin, args, files = [] }: StepCommand,
  cwd: string,
): Effect.Effect<number, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
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
    }),
  )
}
