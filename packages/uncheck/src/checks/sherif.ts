import process from 'node:process'

import { Effect, FileSystem, Path, Predicate } from 'effect'

import { CannotCheck, NothingToCheck } from '../errors'
import { readJson } from '../files'
import { resolveBin } from '../tool'
import type { Check } from '../types'

const WORKSPACE_FILES = new Set(['package.json', 'pnpm-workspace.yaml'])

// pnpm also keeps its settings in pnpm-workspace.yaml, and sherif fails on one without packages.
const DECLARES_PACKAGES = /^["']?packages["']?\s*:/m

export const sherif: Check = {
  name: 'sherif',
  fixes: 'workspace',
  plan: Effect.fn(function* ({ cwd, fix, files, deleted }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const bin = yield* resolveBin('sherif', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    if (
      files !== undefined &&
      ![...files, ...deleted].some((file) => WORKSPACE_FILES.has(path.basename(file)))
    ) {
      return yield* Effect.fail(
        new NothingToCheck({ reason: 'no package.json among the given files', unrelated: true }),
      )
    }

    const [manifest, pnpmWorkspace] = yield* Effect.all(
      [
        readJson(path.join(cwd, 'package.json')),
        fs.readFileString(path.join(cwd, 'pnpm-workspace.yaml')).pipe(
          Effect.map((text) => DECLARES_PACKAGES.test(text)),
          Effect.orElseSucceed(() => false),
        ),
      ],
      { concurrency: 'unbounded' },
    )

    if (manifest === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no package.json found' }))
    }

    if (manifest.workspaces === undefined && !pnpmWorkspace) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not a workspace root' }))
    }

    if (!fix || process.env.CI !== undefined) {
      // sherif reads this setting on every run, and no flag turns it off.
      if (Predicate.hasProperty(manifest.sherif, 'fix') && manifest.sherif.fix === true) {
        return yield* Effect.fail(
          new CannotCheck({
            reason:
              'would fix files while uncheck only reports, remove "fix": true from the sherif field of package.json',
          }),
        )
      }

      return [{ bin, args: [] }]
    }

    return [
      {
        bin,
        args: Predicate.hasProperty(manifest.sherif, 'select')
          ? ['--fix']
          : ['--fix', '--select=highest'],
      },
    ]
  }),
}
