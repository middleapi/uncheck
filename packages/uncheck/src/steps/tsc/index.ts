import type { PlatformError } from 'effect'
import type { ProjectFiles } from '../../files'
import type { Step, StepCommand, StepPlan } from '../../step'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import { Data, Effect, FileSystem, Graph, Option, Path } from 'effect'
import { resolveBin } from '../../resolve'
import { settled } from '../../step'
import { extensionOf, includesFile, loadTsconfigInputs, readReferences } from './tsconfig'

export const tsc: Step = {
  name: 'tsc',
  does: 'Typecheck with tsc',
  when: 'a tsconfig.json is found',
  fixes: false,
  plan: ({ cwd, files, required, projectFiles }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const nothingToCheck = (reason: string) => settled('tsc', required, reason)

      const targets = files
        ?.map(file => path.resolve(cwd, file))
        .filter(file => CHECKABLE_EXTENSIONS.has(extensionOf(file)))

      if (targets !== undefined && targets.length === 0) {
        return nothingToCheck('no tsconfig.json covers the given files')
      }

      const [typescript, tsconfigs] = yield* Effect.all(
        [resolveBin('typescript', cwd, 'tsc'), discoverTsconfigs(projectFiles, cwd)],
        { concurrency: 'unbounded' },
      )

      if (tsconfigs.length === 0) {
        return nothingToCheck('no tsconfig.json found')
      }

      const selected = targets === undefined ? tsconfigs : yield* selectTsconfigs(tsconfigs, targets)

      if (selected.length === 0) {
        return nothingToCheck('no tsconfig.json covers the given files')
      }

      if (Option.isNone(typescript)) {
        return {
          name: 'tsc',
          status: 'failed',
          reason: `found ${selected.length} tsconfig.json but typescript is not installed`,
        }
      }

      const bin = typescript.value
      const relative = (configPath: string) => path.relative(cwd, configPath) || '.'
      const projects = yield* loadTsProjects(selected)

      return yield* planTypecheck(selected, projects).pipe(
        Effect.map((plan): StepPlan => {
          const commands: StepCommand[] = []

          if (plan.build.length > 0) {
            commands.push({ bin, args: ['-b', ...plan.build.map(relative)] })
          }

          for (const configPath of plan.check) {
            commands.push({ bin, args: ['-p', relative(configPath)] })
          }

          return { name: 'tsc', status: 'run', commands }
        }),
        Effect.catchTag('CircularProjectReferences', error =>
          Effect.succeed<StepPlan>({
            name: 'tsc',
            status: 'failed',
            reason: `circular project references between ${error.projects.map(relative).join(', ')}`,
          }),
        ),
      )
    }),
}

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

/** Files that can be inputs of some project; anything else never selects one. */
const CHECKABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'])

/**
 * Narrows `entries` to the projects whose `files`/`include`/`exclude` (with `extends` applied) take
 * one of the absolute `files` as input, exactly like `tsc` decides.
 */
export function selectTsconfigs(
  entries: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.filter(
    entries,
    entry => Effect.map(loadTsconfigInputs(entry), inputs => files.some(file => includesFile(inputs, file))),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map(selected => [...selected].sort()))
}

/** Parses `entries` and everything they reference, transitively, into a graph keyed by config path. */
function loadTsProjects(
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

/** Every `tsconfig.json` in the project, as absolute paths. */
function discoverTsconfigs(
  projectFiles: ProjectFiles,
  cwd: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files = yield* projectFiles

    const candidates = files
      .filter(file => path.basename(file) === 'tsconfig.json')
      .map(file => path.resolve(cwd, file))

    // Tracked files can be deleted from the working tree without being staged yet.
    return yield* Effect.filter(candidates, candidate => fs.exists(candidate), { concurrency: 'unbounded' })
  })
}
