import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Console, Effect } from 'effect'
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from 'effect/cli'

import pkg from '../package.json' with { type: 'json' }
import { hooks } from './commands/hooks/index.ts'
import { init } from './commands/init.ts'
import { prepare } from './commands/prepare.ts'
import { staged } from './commands/staged.ts'
import { uncheck } from './commands/uncheck.ts'

// Any failed write (a reader gone after `| head`, a closed terminal, a full disk) would otherwise end
// the run before `staged` puts unstaged changes back, so output errors are ignored.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {})
}

// A closed terminal kills on SIGHUP before `staged` puts unstaged changes back, and sends it twice
// (the shell forwards it, then the kernel), so `once` is not enough.
process.on('SIGHUP', () => process.kill(process.pid, 'SIGTERM'))

Command.run(uncheck.pipe(Command.withSubcommands([init, staged, prepare, hooks])), {
  version: pkg.version,
}).pipe(
  Effect.catchTag('CheckFailed', () =>
    Effect.sync(() => {
      process.exitCode = 1
    }),
  ),
  Effect.catchTag('StopBlocked', () =>
    Effect.sync(() => {
      process.exitCode = 2
    }),
  ),
  Effect.catchTag('PlatformError', (error) =>
    Effect.gen(function* () {
      const formatter = yield* CliOutput.Formatter

      yield* Console.error(
        formatter.formatError(new CliError.UserError({ cause: error, userMessage: error.message })),
      )
      process.exitCode = 1
    }),
  ),
  Effect.provide(
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
