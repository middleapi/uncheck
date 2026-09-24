import { existsSync } from 'node:fs'

import { Effect, FileSystem, Path, Predicate } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import { Minimatch } from 'minimatch'

import { gitPaths } from './git'

export type ProjectFiles = Effect.Effect<
  ReadonlyArray<string>,
  never,
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
    // git lists a linked node_modules as one file, which a `node_modules/` ignore rule misses.
    Effect.map((files) => files.filter((file) => !/(?:^|\/)node_modules(?:\/|$)/.test(file))),
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
  return Effect.all(
    [
      gitPaths(cwd, ['diff', '--name-only', '--relative', '-z', 'HEAD']),
      gitPaths(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(([tracked, untracked]) => [...new Set([...tracked, ...untracked])].sort()),
    Effect.orElseSucceed(() => undefined),
  )
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

  const includes = patterns.filter((pattern) => !pattern.startsWith('!'))
  const matched = new Set<string>()
  const unmatched: string[] = []
  let universe: ReadonlyArray<string> | undefined

  for (const pattern of includes.length > 0 ? includes : ['.']) {
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

    if (kind !== 'Directory' && !GLOB_CHARACTERS.test(target)) {
      unmatched.push(pattern)
      continue
    }

    universe ??= yield* projectFiles
    const hits = universe.filter(
      kind === 'Directory'
        ? (file) => target === '' || file.startsWith(`${target}/`)
        : glob(target),
    )

    for (const hit of hits) {
      matched.add(hit)
    }

    if (hits.length === 0) {
      unmatched.push(pattern)
    }
  }

  const excludes = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => {
      const target = relative(pattern.slice(1))

      if (target === '') {
        return () => true
      }

      const matches = glob(target)

      return (file: string) => file === target || file.startsWith(`${target}/`) || matches(file)
    })

  // One fiber per file costs far more than the check itself on a large project.
  const files = yield* Effect.sync(() =>
    [...matched].filter(
      (file) => !excludes.some((excluded) => excluded(file)) && existsSync(path.resolve(cwd, file)),
    ),
  )

  return { files: files.sort(), unmatched }
})

const GLOB_CHARACTERS = /[*?[\]{}()]/

/** Dot files match too, as they do for oxfmt and for a directory given as it is. */
function glob(pattern: string): (file: string) => boolean {
  // Level 2 drops the `.` of `src/{.,deep}/*.ts` as path.matchesGlob does.
  const matcher = new Minimatch(pattern, {
    dot: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    platform: 'linux',
  })

  return (file) => matcher.match(file)
}

export const existingFiles = Effect.fn(function* (files: ReadonlyArray<string>, cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // A concurrent `Effect.filter` keeps files in the order their checks finish, not the given one.
  const isFile = yield* Effect.forEach(
    files,
    (file) =>
      fs.stat(path.resolve(cwd, file)).pipe(
        Effect.map((info) => info.type === 'File'),
        Effect.orElseSucceed(() => false),
      ),
    { concurrency: 64 },
  )

  return files.filter((_, index) => isFile[index])
})

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

  const visit = Effect.fn(function* (dir: string): Effect.fn.Return<void> {
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))

    yield* Effect.forEach(names, (name) => visitEntry(dir, name), {
      concurrency: 16,
      discard: true,
    })
  })

  const visitEntry = Effect.fn(function* (dir: string, name: string): Effect.fn.Return<void> {
    if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) {
      return
    }

    const full = path.join(dir, name)
    const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))

    if (info?.type === 'Directory') {
      // `stat` follows links, and a link back up the tree would be walked forever.
      const linked = yield* fs.readLink(full).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )

      if (!linked) {
        yield* visit(full)
      }
    } else if (info?.type === 'File') {
      found.push(path.relative(root, full).replaceAll('\\', '/'))
    }
  })

  yield* visit(root)

  return found
})

export const readTextIfExists = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem

  return yield* fs
    .readFileString(file)
    .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)))
})
