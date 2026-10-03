import { Effect } from 'effect'

import { NothingToCheck } from '../errors.ts'
import { argvBatches, resolveBin } from '../tool.ts'
import type { Check } from '../types.ts'

export const oxfmt: Check = {
  name: 'oxfmt',
  fixes: 'files',
  plan: Effect.fn(function* ({ cwd, fix, files }) {
    const bin = yield* resolveBin('oxfmt', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    // A folder with nothing oxfmt handles, or a given file it does not (a .txt file), is no failure.
    const args = [...(fix ? [] : ['--check']), '--no-error-on-unmatched-pattern']

    if (files === undefined) {
      return [{ bin, args }]
    }

    return argvBatches(files).map((batch) => ({ bin, args, files: batch }))
  }),
}
