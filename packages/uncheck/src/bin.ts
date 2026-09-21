#!/usr/bin/env node
import process from 'node:process'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { Command } from 'effect/unstable/cli'
import pkg from '../package.json'
import { command } from './command'

Command.run(command, { version: pkg.version }).pipe(
  // The summary is already printed, only the exit code is left to report.
  Effect.catchTag('CheckFailed', () =>
    Effect.sync(() => {
      process.exitCode = 1
    }),
  ),
  // Exit code 2 is how Claude Code and CodeBuddy stop hooks send the agent back to work.
  Effect.catchTag('StopBlocked', () =>
    Effect.sync(() => {
      process.exitCode = 2
    }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
