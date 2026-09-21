import { Effect } from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import { fixFlag, runChecks, stepFlags } from './checks'
import { hooksCommand } from './hooks'

export const command = Command.make(
  'uncheck',
  {
    fix: fixFlag,
    allowUnmatched: Flag.Boolean('no-error-on-unmatched-pattern').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Run with whatever matched instead of failing when a given path or pattern matches no file'),
    ),
    ...stepFlags,
    paths: Argument.String('paths').pipe(
      Argument.variadic(),
      Argument.withDescription(
        'Files, directories or glob patterns, `!pattern` excludes. uncheck resolves them to one file list that every tool checks, so tools never disagree on what a pattern means. Defaults to the whole project.',
      ),
    ),
  },
  ({ fix, allowUnmatched, paths, ...flags }) => Effect.suspend(() => runChecks(paths, { fix, flags, allowUnmatched })),
).pipe(
  Command.withDescription(
    'Lint (oxlint), format check (oxfmt) and typecheck (tsc) a project with one command. Each step runs only when the project uses that tool.',
  ),
  Command.withSubcommands([hooksCommand]),
)
