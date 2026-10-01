import { Effect } from 'effect'

import { NothingToCheck } from '../errors'
import { argvBatches, resolveBin } from '../tool'
import type { Check } from '../types'

export const oxfmt: Check = {
  name: 'oxfmt',
  fixes: 'files',
  plan: Effect.fn(function* ({ cwd, fix, files }) {
    const bin = yield* resolveBin('oxfmt', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    // An empty list makes no batch, so the check would pass without running. Kept skipped when
    // required, or `--require=oxfmt` would block every commit that only deletes files.
    if (files?.length === 0) {
      return yield* Effect.fail(
        new NothingToCheck({ reason: 'only deleted files', unrelated: true, evenIfRequired: true }),
      )
    }

    // A folder with nothing oxfmt handles, or a given file it does not (a .txt file), is no failure.
    const args = [...(fix ? [] : ['--check']), '--no-error-on-unmatched-pattern']

    if (files === undefined) {
      return [{ bin, args }]
    }

    return argvBatches(files).map((batch) => ({ bin, args, files: batch }))
  }),
}
