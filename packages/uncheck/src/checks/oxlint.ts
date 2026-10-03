import { Effect } from 'effect'

import { NothingToCheck } from '../errors.ts'
import { argvBatches, resolveBin } from '../tool.ts'
import type { Check } from '../types.ts'

export const oxlint: Check = {
  name: 'oxlint',
  fixes: 'files',
  plan: Effect.fn(function* ({ cwd, fix, files }) {
    const bin = yield* resolveBin('oxlint', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    const args = [
      ...(fix ? ['--fix'] : []),
      // oxlint walks into node_modules unless an ignore file says not to, and a fix there rewrites
      // installed packages, through pnpm's hard links even those of its shared store.
      ...(files === undefined ? ['--ignore-pattern=node_modules'] : []),
      // A folder with nothing oxlint handles, or a given file it does not (a .md file), is no failure.
      '--no-error-on-unmatched-pattern',
    ]

    if (files === undefined) {
      return [{ bin, args }]
    }

    return argvBatches(files).map((batch) => ({ bin, args, files: batch }))
  }),
}
