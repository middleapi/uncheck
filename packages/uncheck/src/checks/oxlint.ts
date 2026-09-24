import { Effect } from 'effect'

import { NothingToCheck } from '../errors'
import { argvBatches, resolveBin } from '../tool'
import type { Check } from '../types'

export const oxlint: Check = {
  name: 'oxlint',
  fixes: 'files',
  plan: Effect.fn(function* ({ cwd, fix, files }) {
    const bin = yield* resolveBin('oxlint', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    const args = fix ? ['--fix'] : []

    if (files === undefined) {
      return [{ bin, args }]
    }

    // Given files may include ones oxlint does not handle (a Markdown file), which is not a failure.
    return argvBatches(files).map((batch) => ({
      bin,
      args: [...args, '--no-error-on-unmatched-pattern'],
      files: batch,
    }))
  }),
}
