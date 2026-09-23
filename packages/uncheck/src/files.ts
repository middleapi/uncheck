import { posix } from 'node:path'

import type { PlatformError } from 'effect'
import { Effect, FileSystem, Path, Predicate } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { gitPaths } from './git'

export type ProjectFiles = Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>

/**
 * Every file in the project, relative to `cwd` with forward slashes.
 *
 * Prefers `git ls-files` so ignored files stay out and untracked ones count, exactly like the user
 * configured, and falls back to a plain directory walk outside git repositories.
 */
export function listProjectFiles(cwd: string): ProjectFiles {
  return gitPaths(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).pipe(
    Effect.map((files) => files.filter((file) => !file.split('/').includes('node_modules'))),
    Effect.catch(() => walk(cwd)),
    Effect.map((files) => [...files].sort()),
  )
}

/**
 * The files changed since the last commit, relative to `cwd`: modified or staged tracked files plus
 * untracked ones, ignored files excluded. `undefined` outside a git repository or before the first
 * commit, which callers treat as "everything under `cwd`".
 */
export function listChangedFiles(
  cwd: string,
): Effect.Effect<
  ReadonlyArray<string> | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.all([
    gitPaths(cwd, ['diff', '--name-only', '--relative', '-z', 'HEAD']),
    gitPaths(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]).pipe(
    Effect.map(([tracked, untracked]) => [...new Set([...tracked, ...untracked])].sort()),
    Effect.orElseSucceed(() => undefined),
  )
}

export interface ResolvedPaths {
  readonly files: ReadonlyArray<string>
  readonly unmatched: ReadonlyArray<string>
}

/** Turns the given paths into the project files they name, so every tool checks the same files. */
export const resolvePaths = Effect.fn(function* (
  patterns: ReadonlyArray<string>,
  cwd: string,
  projectFiles: ProjectFiles,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const relative = (pattern: string) =>
    path.relative(cwd, path.resolve(cwd, pattern)).replaceAll('\\', '/')

  const matched = new Set<string>()
  const unmatched: string[] = []
  let universe: ReadonlyArray<string> | undefined

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      continue
    }

    const target = relative(pattern)

    // An existing path is taken as it is, so `app/[id].ts` names that file rather than a glob.
    const kind = yield* fs.stat(path.resolve(cwd, pattern)).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => undefined),
    )

    if (kind === 'File') {
      matched.add(target)
      continue
    }

    if (kind === 'Directory') {
      universe ??= yield* projectFiles
      const inside =
        target === '' ? universe : universe.filter((file) => file.startsWith(`${target}/`))

      for (const file of inside) {
        matched.add(file)
      }

      if (inside.length === 0) {
        unmatched.push(pattern)
      }

      continue
    }

    if (GLOB_CHARACTERS.test(target)) {
      universe ??= yield* projectFiles
      const hits = universe.filter((file) => posix.matchesGlob(file, target))

      for (const hit of hits) {
        matched.add(hit)
      }

      if (hits.length === 0) {
        unmatched.push(pattern)
      }

      continue
    }

    unmatched.push(pattern)
  }

  const excludes = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => relative(pattern.slice(1)))
  const excluded = (file: string) =>
    excludes.some(
      (exclude) =>
        file === exclude || file.startsWith(`${exclude}/`) || posix.matchesGlob(file, exclude),
    )

  const files = yield* Effect.filter(
    [...matched].filter((file) => !excluded(file)),
    (file) => fs.exists(path.resolve(cwd, file)).pipe(Effect.orElseSucceed(() => false)),
    { concurrency: 'unbounded' },
  )

  return { files: files.sort(), unmatched }
})

const GLOB_CHARACTERS = /[*?[\]{}()]/

export function ancestors(path: Path.Path, from: string): string[] {
  const dirs = [path.resolve(from)]

  for (
    let parent = path.dirname(dirs[0]!);
    parent !== dirs[dirs.length - 1];
    parent = path.dirname(parent)
  ) {
    dirs.push(parent)
  }

  return dirs
}

export const readJson = Effect.fn(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    const value: unknown = yield* Effect.try(() => JSON.parse(text))

    return Predicate.isObject(value) ? value : undefined
  },
  Effect.orElseSucceed(() => undefined),
)

/** The folders `tsc` itself never looks into. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'bower_components', 'jspm_packages'])

const walk = Effect.fn(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(cwd)
  const found: string[] = []

  const visit = Effect.fn(function* (
    dir: string,
  ): Effect.fn.Return<void, PlatformError.PlatformError> {
    const names = yield* fs.readDirectory(dir)

    yield* Effect.forEach(names, (name) => visitEntry(dir, name), {
      concurrency: 16,
      discard: true,
    })
  })

  const visitEntry = Effect.fn(function* (
    dir: string,
    name: string,
  ): Effect.fn.Return<void, PlatformError.PlatformError> {
    if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) {
      return
    }

    const full = path.join(dir, name)
    const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))

    if (info?.type === 'Directory') {
      yield* visit(full)
    } else if (info?.type === 'File') {
      found.push(path.relative(root, full).replaceAll('\\', '/'))
    }
  })

  yield* visit(root)

  return found
})
