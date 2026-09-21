import { Argument, Command, Flag } from 'effect/unstable/cli'
import { runChecks } from '../run'
import { cwdFlag, fixFlag, requireFlag, skipFlag } from './flags'
import { hooks } from './hooks'

export const uncheck = Command.make(
  'uncheck',
  {
    cwd: cwdFlag,
    fix: fixFlag,
    allowUnmatched: Flag.Boolean('no-error-on-unmatched-pattern').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Run with whatever matched instead of failing when a given path or pattern matches no file'),
    ),
    required: requireFlag,
    skipped: skipFlag,
    paths: Argument.String('paths').pipe(
      Argument.variadic(),
      Argument.withDescription(
        'Files, directories or glob patterns, `!pattern` excludes. uncheck resolves them to one file list that every tool checks, so tools never disagree on what a pattern means. Defaults to everything under the current directory.',
      ),
    ),
  },
  ({ paths, ...settings }) => runChecks(paths, settings),
).pipe(
  Command.withDescription(
    'Lint (oxlint), format check (oxfmt) and typecheck (tsc) a project with one command. Each check runs only when the project uses that tool.',
  ),
  Command.withSubcommands([hooks]),
)
