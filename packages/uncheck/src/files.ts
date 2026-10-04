import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'

import { Effect, FileSystem, Option, Path, Predicate } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { Minimatch } from 'minimatch'

import { userError } from './errors.ts'
import { gitPaths, rawDiff } from './git.ts'

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
    Effect.map((files) => files.filter((file) => !inNodeModules(file))),
    Effect.catch(() => walk(cwd)),
    // git lists a file with merge conflicts once per side.
    Effect.map((files) => [...new Set(files)].sort()),
  )
}

// Ignore rules can miss it (a linked one, a nested one under `/node_modules`, or no rule at all), and a
// fix there rewrites installed packages, through pnpm's hard links even those of its shared store.
export function inNodeModules(file: string): boolean {
  return /(?:^|\/)node_modules(?:\/|$)/.test(file)
}

interface ChangedFiles {
  readonly files: ReadonlyArray<string>
  readonly deleted: ReadonlyArray<string>
}

/**
 * The files changed since the last commit, relative to `cwd`: modified or staged tracked files plus
 * untracked ones, ignored files excluded, and apart from them the deleted ones, the old path of a
 * rename included. `undefined` outside a git repository or before the first commit, which callers
 * treat as "everything under `cwd`".
 */
export function listChangedFiles(
  cwd: string,
): Effect.Effect<ChangedFiles | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.all(
    [rawDiff(cwd, 'HEAD'), gitPaths(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(([tracked, untracked]) => {
      const changed = tracked.filter((entry) => entry.status !== 'D').map((entry) => entry.file)
      const deleted = tracked.filter((entry) => entry.status === 'D').map((entry) => entry.file)

      return {
        files: [...new Set([...changed, ...untracked])]
          .filter((file) => !inNodeModules(file))
          .sort(),
        deleted: deleted.filter((file) => !inNodeModules(file)),
      }
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

/** Turns the given paths into the project files they name, so every tool checks the same files. */
export const resolvePaths = Effect.fn(function* (
  patterns: ReadonlyArray<string>,
  cwd: string,
  projectFiles: ProjectFiles,
) {
  const path = yield* Path.Path
  const realCwd = realpathSync(cwd)
  const isCheckable = checkableFile(path, cwd, realCwd)

  const relative = (pattern: string) => {
    const resolved = path.resolve(cwd, pattern)
    const lexical = slashedRelative(path, cwd, resolved)

    if (!isOutside(path, lexical)) {
      return lexical
    }

    // The current directory is a real path, while an absolute path may run through a linked folder.
    // `throwIfNoEntry` spares only missing paths: a locked folder or a looping link still throws.
    try {
      const real = slashedRelative(path, realCwd, resolveFolders(path, resolved))

      return isOutside(path, real) ? lexical : real
    } catch {
      return lexical
    }
  }

  const includes = patterns.filter((pattern) => !pattern.startsWith('!'))
  const matched = new Set<string>()
  const named = new Set<string>()
  const unmatched: string[] = []
  let universe: ReadonlyArray<string> | undefined

  for (const pattern of includes.length > 0 ? includes : ['.']) {
    const target = relative(pattern)

    // oxlint and oxfmt reject a path containing "..".
    if (isOutside(path, target)) {
      return yield* userError(
        `${pattern} is outside ${cwd}, run from a folder that contains it or pass one with --cwd`,
      )
    }

    // An existing path is taken as it is, so `app/[id].ts` names that file rather than a glob.
    const kind = yield* fileKind(path.resolve(cwd, pattern))

    if (kind === 'File') {
      matched.add(target)
      named.add(target)
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

    if (!hits.some((hit) => isCheckable(hit))) {
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

      // As for an inclusion, so `![id].ts` leaves out that file and not `i.ts` too.
      if (existsSync(path.resolve(cwd, pattern.slice(1)))) {
        return (file: string) => file === target || file.startsWith(`${target}/`)
      }

      const matches = glob(target)
      const matchesInside = glob(`${target}/**`)

      return (file: string) => matches(file) || matchesInside(file)
    })

  // One fiber per file costs far more than the check itself on a large project.
  const files = yield* Effect.sync(() =>
    [...matched].filter(
      (file) =>
        !excludes.some((excluded) => excluded(file)) && (named.has(file) || isCheckable(file)),
    ),
  )

  return { files: files.sort(), unmatched }
})

export const checkableFiles = Effect.fn(function* (files: ReadonlyArray<string>, cwd: string) {
  const path = yield* Path.Path
  const isCheckable = checkableFile(path, cwd, realpathSync(cwd))

  return files.filter((file) => isCheckable(file))
})

const GLOB_CHARACTERS = /[*?[\]{}()]/

// git lists a linked folder as one file, and a fix through a link rewrites its target, so of the links
// only those to a file inside `cwd` and outside node_modules are kept.
function checkableFile(path: Path.Path, cwd: string, realCwd: string): (file: string) => boolean {
  return (file) => {
    const absolute = path.resolve(cwd, file)

    try {
      const info = lstatSync(absolute)

      if (!info.isSymbolicLink()) {
        return info.isFile()
      }

      const target = realpathSync(absolute)
      const relativeTarget = slashedRelative(path, realCwd, target)

      return (
        statSync(target).isFile() &&
        !isOutside(path, relativeTarget) &&
        !inNodeModules(relativeTarget)
      )
    } catch {
      return false
    }
  }
}

export function isOutside(path: Path.Path, relative: string): boolean {
  return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
}

export function slashedRelative(path: Path.Path, from: string, to: string): string {
  // A backslash is a glob escape on POSIX, never a separator.
  return path.relative(from, to).split(path.sep).join('/')
}

/** `file` with every linked folder on its way resolved. A linked file keeps its own name. */
export function resolveFolders(path: Path.Path, file: string): string {
  const rest: string[] = []
  let folder = file

  while (!isDirectory(folder)) {
    rest.unshift(path.basename(folder))
    folder = path.dirname(folder)
  }

  return path.join(realpathSync(folder), ...rest)
}

function isDirectory(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isDirectory() === true
}

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

/**
 * The folders above `cwd` up to the top of its git repository, nearest first, and none outside one: a
 * config above the repository, say in the home folder, belongs to another project.
 */
export const foldersAboveInRepository = Effect.fn(function* (cwd: string) {
  const path = yield* Path.Path
  const dirs = ancestors(path, cwd)
  const top = yield* Effect.findFirst(dirs, (dir) =>
    Effect.map(fileKind(path.join(dir, '.git')), (kind) => kind !== undefined),
  )

  return Option.match(top, {
    onNone: () => [],
    onSome: (dir) => dirs.slice(1, dirs.indexOf(dir) + 1),
  })
})

export const fileKind = Effect.fn(function* (target: string) {
  const fs = yield* FileSystem.FileSystem

  return yield* fs.stat(target).pipe(
    Effect.map((info) => info.type),
    Effect.orElseSucceed(() => undefined),
  )
})

export const firstFile = (candidates: ReadonlyArray<string>) =>
  Effect.findFirst(candidates, (candidate) =>
    Effect.map(fileKind(candidate), (type) => type === 'File'),
  )

export const readJson = Effect.fn(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    const value: unknown = yield* Effect.try(() => JSON.parse(text))

    return Predicate.isObject(value) ? value : undefined
  },
  Effect.orElseSucceed(() => undefined),
)

// pnpm also keeps its settings in pnpm-workspace.yaml, and sherif fails on one without packages.
const DECLARES_PACKAGES = /^["']?packages["']?\s*:/m

export const isWorkspaceRoot = Effect.fn(function* (
  dir: string,
  manifest: Readonly<Record<string, unknown>>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return (
    manifest.workspaces !== undefined ||
    (yield* fs.readFileString(path.join(dir, 'pnpm-workspace.yaml')).pipe(
      Effect.map((text) => DECLARES_PACKAGES.test(text)),
      Effect.orElseSucceed(() => false),
    ))
  )
})

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
