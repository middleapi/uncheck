#!/usr/bin/env node

import process from 'node:process'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { Command } from 'effect/unstable/cli'
import pkg from '../package.json'
import { hooks } from './commands/hooks'
import { uncheck } from './commands/uncheck'

Command.run(uncheck.pipe(Command.withSubcommands([hooks])), { version: pkg.version }).pipe(
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
