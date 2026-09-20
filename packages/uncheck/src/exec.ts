import type { PlatformError } from 'effect'
import type { UncheckOptions } from './options'
import type { Tool } from './tools'
import process from 'node:process'
import { Effect, Stream, Terminal } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/**
 * Runs `tool` with `args` and resolves with its exit code.
 * A non-zero exit code is a normal result, not a failure.
 */
export function execTool(
  tool: Tool,
  args: ReadonlyArray<string>,
  options: UncheckOptions,
): Effect.Effect<number, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner | Terminal.Terminal> {
  const inherit = options.stdio === 'inherit'

  const command = ChildProcess.make(process.execPath, [tool.bin, ...args], {
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: inherit ? 'inherit' : 'pipe',
    stderr: inherit ? 'inherit' : 'pipe',
  })

  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    if (inherit) {
      return yield* spawner.exitCode(command)
    }

    const terminal = yield* Terminal.Terminal

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)

        yield* Stream.runForEach(Stream.decodeText(handle.all), chunk => terminal.display(chunk))

        return yield* handle.exitCode
      }),
    )
  })
}
