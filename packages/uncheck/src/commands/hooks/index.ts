import { Command } from 'effect/unstable/cli'

import { install } from './install'
import { run } from './run'

export const hooks = Command.make('hooks').pipe(
  Command.withDescription('Agent hooks: `install` writes the configs, `run` is what they execute'),
  Command.withSubcommands([install, run]),
)
