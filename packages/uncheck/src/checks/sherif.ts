import type { Check } from '../types'
import process from 'node:process'
import { Effect, FileSystem, Path, Predicate } from 'effect'
import { NothingToCheck } from '../errors'
import { readJson } from '../files'
import { resolveBin } from '../tool'

const WORKSPACE_FILES = new Set(['package.json', 'pnpm-workspace.yaml'])

export const sherif: Check = {
  name: 'sherif',
  fixes: true,
  plan: Effect.fn(function* ({ cwd, fix, files }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    if (files?.some(file => WORKSPACE_FILES.has(path.basename(file))) === false) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no package.json among the given files' }))
    }

    const [bin, manifest, pnpmWorkspace] = yield* Effect.all(
      [
        resolveBin('sherif', cwd),
        readJson(path.join(cwd, 'package.json')),
        fs.exists(path.join(cwd, 'pnpm-workspace.yaml')).pipe(Effect.orElseSucceed(() => false)),
      ],
      { concurrency: 'unbounded' },
    )

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    if (manifest === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no package.json found' }))
    }

    if (manifest.workspaces === undefined && !pnpmWorkspace) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not a workspace root' }))
    }

    if (!fix || process.env.CI !== undefined) {
      return [{ bin, args: [] }]
    }

    return [{ bin, args: Predicate.hasProperty(manifest.sherif, 'select') ? ['--fix'] : ['--fix', '--select=highest'] }]
  }),
}
