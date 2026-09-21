import process from 'node:process'
import { Effect } from 'effect'
import { Flag } from 'effect/unstable/cli'
import { CHECKS } from '../run'

export const cwdFlag = Flag.Directory('cwd', { mustExist: true }).pipe(
  Flag.withDefault(Effect.sync(() => process.cwd())),
  Flag.withDescription('Directory to run in. Defaults to the current one'),
)

export const fixFlag = Flag.Boolean('fix').pipe(
  Flag.withDescription('Apply lint fixes (oxlint --fix) and rewrite formatting (oxfmt) instead of only reporting'),
  Flag.withDefault(false),
)

const CHECK_NAMES = CHECKS.map(check => check.name)

export const requireFlag = Flag.Literals('require', CHECK_NAMES).pipe(
  Flag.atLeast(0),
  Flag.withDescription('Require a check: fail when it cannot run instead of skipping it. Repeatable'),
)

export const skipFlag = Flag.Literals('skip', CHECK_NAMES).pipe(
  Flag.atLeast(0),
  Flag.withDescription('Skip a check even when it could run. Repeatable'),
)
