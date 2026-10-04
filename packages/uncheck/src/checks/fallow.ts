import { Effect, Path } from 'effect'

import { NothingToCheck } from '../errors.ts'
import { foldersInRepository, isWorkspaceRoot, readJson, slashedRelative } from '../files.ts'
import { argvBatches, resolveBin } from '../tool.ts'
import type { Check } from '../types.ts'

/** fallow takes one path to report on as an argument, and any number of files with `--file`. */
const FILE_PREFIX = '--file='

/**
 * Where fallow runs: the nearest workspace root at or above `cwd`, else the nearest package. Run in
 * a package or a folder, fallow would miss the entry points the rest of the project declares, and
 * report the files they reach as unused.
 */
const projectRoot = Effect.fn(function* (cwd: string) {
  const path = yield* Path.Path
  let nearest: string | undefined

  for (const dir of yield* foldersInRepository(cwd)) {
    const manifest = yield* readJson(path.join(dir, 'package.json'))

    if (manifest === undefined) {
      continue
    }

    if (yield* isWorkspaceRoot(dir, manifest)) {
      return dir
    }

    nearest ??= dir
  }

  return nearest
})

export const fallow: Check = {
  name: 'fallow',
  // `fallow fix` deletes what it takes for unused, and fallow misses the uses it cannot see, such as
  // a package that only another tool loads.
  fixes: false,
  plan: Effect.fn(function* ({ cwd, files }) {
    const path = yield* Path.Path

    const bin = yield* resolveBin('fallow', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    const root = yield* projectRoot(cwd)

    if (root === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no package.json found' }))
    }

    // Without a file to report on, fallow would report on the whole project.
    if (files !== undefined && files.length === 0) {
      return []
    }

    const folder = slashedRelative(path, root, cwd)
    const args = [
      'dead-code',
      // Its progress and summary go to stderr, and can show up among the findings it prints on
      // stdout. Warnings and errors still go to stderr.
      '--quiet',
      ...(folder === '' ? [] : [`--root=${slashedRelative(path, cwd, root)}`]),
    ]

    if (files === undefined) {
      // fallow reads `.` from the current folder, not from its root, and reports only on that folder.
      return [{ bin, args: folder === '' ? args : [...args, '.'] }]
    }

    // fallow reads the files from its root, not from the current folder.
    const fromRoot = files.map((file) => (folder === '' ? file : `${folder}/${file}`))

    return argvBatches(fromRoot, FILE_PREFIX).map((batch) => ({
      bin,
      args,
      files: batch,
      filePrefix: FILE_PREFIX,
    }))
  }),
}
