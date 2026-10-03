import { Command } from 'effect/cli'

import { install } from './install.ts'
import { run } from './run.ts'

export const hooks = Command.make('hooks').pipe(
  Command.withDescription('Agent hooks: `install` writes the configs, `run` is what they execute'),
  Command.withSubcommands([install, run]),
)
