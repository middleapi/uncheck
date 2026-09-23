#!/usr/bin/env node

import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { Command } from 'effect/unstable/cli'

import pkg from '../package.json'
import { hooks } from './commands/hooks'
import { prepare } from './commands/prepare'
import { staged } from './commands/staged'
import { uncheck } from './commands/uncheck'

// A reader that goes away (`| head`) must not end the run before `staged` puts changes back.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {})
}

Command.run(uncheck.pipe(Command.withSubcommands([staged, prepare, hooks])), {
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
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
