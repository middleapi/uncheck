import type { PlatformError } from 'effect'
import { Data, Effect, FileSystem, Graph, Option, Path, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { coversDirectory, includesFile, loadTsconfigInputs, readReferences } from './tsconfig'

export interface TsProject {
  /** Absolute path to the config file. */
  readonly path: string
  /** Absolute paths of the config files listed in `references`. */
  readonly references: ReadonlyArray<string>
}

export interface TypecheckPlan {
  /**
   * Roots of the project-reference graph (projects nobody references).
   * `tsc -b` builds every referenced project first, in dependency order.
   */
  readonly build: ReadonlyArray<string>
  /** Projects outside the reference graph, checked with `tsc -p` after the build step. */
  readonly check: ReadonlyArray<string>
}

export class CircularProjectReferences extends Data.TaggedError('CircularProjectReferences')<{
  readonly projects: ReadonlyArray<string>
}> {}

/**
 * Splits the discovered `entries` into what `tsc -b` must build and what `tsc -p` can check on its own.
 *
 * Every project that has references, or is referenced, belongs to the build graph.
 * Only the graph's roots are passed to `tsc -b` since it builds their references transitively.
 */
export function planTypecheck(
  entries: ReadonlyArray<string>,
  projects: ReadonlyMap<string, TsProject>,
): Effect.Effect<TypecheckPlan, CircularProjectReferences> {
  const members = new Set<string>()
  const referenced = new Set<string>()

  for (const project of projects.values()) {
    if (project.references.length === 0) {
      continue
    }

    members.add(project.path)

    for (const reference of project.references) {
      members.add(reference)
      referenced.add(reference)
    }
  }

  const cycle = findCycle([...members].sort(), projects)

  if (Option.isSome(cycle)) {
    return Effect.fail(new CircularProjectReferences({ projects: cycle.value }))
  }

  return Effect.succeed({
    build: [...members].filter(member => !referenced.has(member)).sort(),
    check: entries.filter(entry => !members.has(entry)).sort(),
  })
}

/** The first cycle among `nodes` following `references`, in visiting order. */
function findCycle(nodes: ReadonlyArray<string>, projects: ReadonlyMap<string, TsProject>): Option.Option<string[]> {
  const graph = Graph.directed<string, null>(mutable => {
    const indexes = new Map(nodes.map(node => [node, Graph.addNode(mutable, node)] as const))

    for (const node of nodes) {
      for (const reference of projects.get(node)?.references ?? []) {
        Graph.addEdge(mutable, indexes.get(node)!, indexes.get(reference)!, null)
      }
    }
  })

  return Option.map(Graph.findCycle(graph), ({ path }) =>
    // The path closes on its first node, drop that repetition.
    path.slice(0, -1).map(index => Option.getOrThrow(Graph.getNode(graph, index))),
  )
}

/**
 * Narrows `entries` to the projects `tsc` would actually check for the given `paths`.
 *
 * A file selects the projects whose `files`/`include`/`exclude` (with `extends` applied) take it as
 * input, exactly like `tsc` decides. A directory, or the static prefix of a glob, selects the
 * projects whose inputs can live under it. Negations are ignored, and no paths means every project.
 */
export function selectTsconfigs(
  entries: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  if (paths.length === 0) {
    return Effect.succeed(entries)
  }

  return Effect.gen(function* () {
    const path = yield* Path.Path

    const targets = paths
      .filter(pattern => !pattern.startsWith('!') && !namesUncheckableExtension(pattern))
      .map(pattern => path.resolve(cwd, staticPrefix(pattern)))

    if (targets.length === 0) {
      return []
    }

    const selected = yield* Effect.filter(
      entries,
      entry =>
        Effect.map(loadTsconfigInputs(entry), inputs =>
          targets.some(target =>
            path.extname(target) === '' ? coversDirectory(inputs, target) : includesFile(inputs, target),
          ),
        ),
      { concurrency: 'unbounded' },
    )

    return [...selected].sort()
  })
}

const CHECKABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'])

/** Whether a path or glob ends in a literal extension `tsc` never reads, like `README.md` or `**\/*.css`. */
function namesUncheckableExtension(pattern: string): boolean {
  const name = pattern.slice(pattern.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot).toLowerCase()

  return extension !== '' && !/[*?[\]{}()]/.test(extension) && !CHECKABLE_EXTENSIONS.has(extension)
}

/** The leading path segments of a glob pattern that contain no wildcard. */
function staticPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const firstWildcard = segments.findIndex(segment => /[*?[\]{}()]/.test(segment))

  return (firstWildcard === -1 ? segments : segments.slice(0, firstWildcard)).join('/')
}

/** Whether `child` is `parent` itself or lies somewhere below it. */
export function isWithin(path: Path.Path, child: string, parent: string): boolean {
  const relative = path.relative(parent, child)

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Parses `entries` and everything they reference, transitively, into a graph keyed by config path. */
export function loadTsProjects(
  entries: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, TsProject>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const projects = new Map<string, TsProject>()
    const queue = [...entries]

    while (queue.length > 0) {
      const configPath = queue.pop()!

      if (projects.has(configPath)) {
        continue
      }

      const references = yield* readReferences(configPath)

      projects.set(configPath, { path: configPath, references })
      queue.push(...references)
    }

    return projects
  })
}

/**
 * Finds every `tsconfig.json` under `cwd`.
 *
 * Prefers `git ls-files` so ignored folders (build output, playgrounds, ...) are excluded exactly
 * like the user configured, and falls back to a plain directory walk outside git repositories.
 */
export function discoverTsconfigs(
  cwd: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return listTsconfigsWithGit(cwd).pipe(
    Effect.catch(() => walkTsconfigs(cwd)),
    Effect.map(found => [...found].sort()),
  )
}

function listTsconfigsWithGit(
  cwd: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError | number,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*tsconfig.json'],
            { cwd, stdin: 'ignore', stderr: 'ignore' },
          ),
        )

        const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
        const exitCode = yield* handle.exitCode

        return exitCode === 0 ? stdout : yield* Effect.fail(exitCode)
      }),
    )

    const candidates = output
      .split('\0')
      .filter(relative => path.basename(relative) === 'tsconfig.json' && !relative.split('/').includes('node_modules'))
      .map(relative => path.resolve(cwd, relative))

    // Tracked files can be deleted from the working tree without being staged yet.
    return yield* Effect.filter(candidates, candidate => fs.exists(candidate), { concurrency: 'unbounded' })
  })
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp', 'temp'])

function walkTsconfigs(
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
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
        } else if (info !== undefined && name === 'tsconfig.json') {
          found.push(full)
        }
      })

    yield* visit(path.resolve(cwd))

    return found
  })
}
