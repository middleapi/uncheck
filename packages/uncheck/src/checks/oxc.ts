import { Effect } from 'effect'

import { NothingToCheck } from '../errors'
import { argvBatches, resolveBin } from '../tool'
import type { Check, CheckName } from '../types'

function oxc(name: CheckName, fixArgs: (fix: boolean) => ReadonlyArray<string>): Check {
  return {
    name,
    fixes: 'files',
    plan: Effect.fn(function* ({ cwd, fix, files }) {
      const bin = yield* resolveBin(name, cwd)

      if (bin === undefined) {
        return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
      }

      if (files === undefined) {
        return [{ bin, args: fixArgs(fix) }]
      }

      // Given files may include ones the tool does not handle (Markdown for oxlint, a .txt file for
      // oxfmt), which is not a failure.
      return argvBatches(files).map((batch) => ({
        bin,
        args: [...fixArgs(fix), '--no-error-on-unmatched-pattern'],
        files: batch,
      }))
    }),
  }
}

export const oxlint = oxc('oxlint', (fix) => (fix ? ['--fix'] : []))

export const oxfmt = oxc('oxfmt', (fix) => (fix ? [] : ['--check']))
