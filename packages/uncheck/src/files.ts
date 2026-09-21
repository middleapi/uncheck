import type { PlatformError } from 'effect'
import { posix } from 'node:path'
import { Effect, FileSystem, Path, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

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
  return git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).pipe(
    Effect.map(files => files.filter(file => !file.split('/').includes('node_modules'))),
    Effect.catch(() => walk(cwd)),
    Effect.map(files => [...files].sort()),
  )
}

/**
 * The files changed since the last commit, relative to `cwd`: modified or staged tracked files plus
 * untracked ones, ignored files excluded. `undefined` outside a git repository or before the first
 * commit, which callers treat as "the whole project".
 */
export function listChangedFiles(
  cwd: string,
): Effect.Effect<ReadonlyArray<string> | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.all([
    git(cwd, ['diff', '--name-only', '--relative', '-z', 'HEAD']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]).pipe(
    Effect.map(([tracked, untracked]) => [...new Set([...tracked, ...untracked])].sort()),
    Effect.orElseSucceed(() => undefined),
  )
}

export interface ResolvedPaths {
  /** Matched files, relative to `cwd`, sorted and unique. */
  readonly files: ReadonlyArray<string>
  /** Patterns that matched nothing. */
  readonly unmatched: ReadonlyArray<string>
}

/**
 * Turns the given paths into the project files they name, so every tool checks the same files.
 *
 * A file must exist, a directory expands to the project files below it, a glob is matched against
 * the project files, and `!pattern` drops matches. Files deleted from the working tree are dropped.
 */
export function resolvePaths(
  patterns: ReadonlyArray<string>,
  cwd: string,
  projectFiles: ProjectFiles,
): Effect.Effect<
  ResolvedPaths,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const relative = (pattern: string) => toPosix(path.relative(cwd, path.resolve(cwd, pattern)))

    const matched = new Set<string>()
    const unmatched: string[] = []
    let universe: ReadonlyArray<string> | undefined

    for (const pattern of patterns) {
      if (pattern.startsWith('!')) {
        continue
      }

      const target = relative(pattern)

      if (GLOB_CHARACTERS.test(target)) {
        universe ??= yield* projectFiles
        const hits = universe.filter(file => posix.matchesGlob(file, target))

        if (hits.length === 0) {
          unmatched.push(pattern)
        }

        for (const hit of hits) {
          matched.add(hit)
        }

        continue
      }

      const kind = yield* fs.stat(path.resolve(cwd, pattern)).pipe(
        Effect.map(info => info.type),
        Effect.orElseSucceed(() => undefined),
      )

      if (kind === 'File') {
        matched.add(target)
        continue
      }

      if (kind === 'Directory') {
        universe ??= yield* projectFiles
        const inside = target === '' ? universe : universe.filter(file => file.startsWith(`${target}/`))

        if (inside.length > 0) {
          for (const file of inside) {
            matched.add(file)
          }

          continue
        }
      }

      unmatched.push(pattern)
    }

    const excludes = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => relative(pattern.slice(1)))
    const excluded = (file: string) =>
      excludes.some(exclude => file === exclude || file.startsWith(`${exclude}/`) || posix.matchesGlob(file, exclude))

    const files = yield* Effect.filter(
      [...matched].filter(file => !excluded(file)),
      file => fs.exists(path.resolve(cwd, file)).pipe(Effect.orElseSucceed(() => false)),
      { concurrency: 'unbounded' },
    )

    return { files: files.sort(), unmatched }
  })
}

/** Characters that make a pattern a glob rather than a plain path. */
const GLOB_CHARACTERS = /[*?[\]{}()]/

/** Runs a git command in `cwd` and returns its NUL-separated output as a list, failing with the exit code. */
function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | number, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const handle = yield* spawner.spawn(ChildProcess.make('git', args, { cwd, stdin: 'ignore', stderr: 'ignore' }))

      const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
      const exitCode = yield* handle.exitCode

      if (exitCode !== 0) {
        return yield* Effect.fail(exitCode)
      }

      return stdout.split('\0').filter(file => file !== '')
    }),
  )
}

/** The folders `tsc` itself never looks into. Hidden entries are skipped as well. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'bower_components', 'jspm_packages'])

function walk(
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.resolve(cwd)
    const found: string[] = []

    const visit = (dir: string): Effect.Effect<void, PlatformError.PlatformError> =>
      fs
        .readDirectory(dir)
        .pipe(
          Effect.flatMap(names =>
            Effect.forEach(names, name => visitEntry(dir, name), { concurrency: 16, discard: true }),
          ),
        )

    const visitEntry = (dir: string, name: string): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) {
          return
        }

        const full = path.join(dir, name)
        const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))

        if (info?.type === 'Directory') {
          yield* visit(full)
        } else if (info?.type === 'File') {
          found.push(toPosix(path.relative(root, full)))
        }
      })

    yield* visit(root)

    return found
  })
}

function toPosix(target: string): string {
  return target.replaceAll('\\', '/')
}
