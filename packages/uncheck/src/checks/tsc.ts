import { posix } from 'node:path'
import process from 'node:process'

import { Data, Effect, FileSystem, Graph, Option, Path, Predicate } from 'effect'
import { parse as parseJsonc } from 'jsonc-parser'

import { CannotCheck, NothingToCheck } from '../errors'
import { ancestors, readJson } from '../files'
import { resolveBin } from '../tool'
import type { Check, CheckCommand } from '../types'

/**
 * TypeScript replaces this token in `extends`, `references` and file specs with the folder of the
 * leaf config.
 */
// oxlint-disable-next-line no-template-curly-in-string
const CONFIG_DIR = '${configDir}'

export const tsc: Check = {
  name: 'tsc',
  fixes: false,
  plan: Effect.fn(function* ({ cwd, files, projectFiles }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const targets = files
      ?.map((file) => path.resolve(cwd, file))
      .filter((file) => CHECKABLE_EXTENSIONS.has(posix.extname(file).toLowerCase()))

    if (targets !== undefined && targets.length === 0) {
      return yield* Effect.fail(
        new NothingToCheck({ reason: 'no tsconfig.json covers the given files' }),
      )
    }

    const [typescript, tsconfigs] = yield* Effect.all(
      [
        resolveBin('typescript', cwd, 'tsc'),
        Effect.flatMap(projectFiles, (all) =>
          // Tracked files can be deleted from the working tree without being staged yet.
          Effect.filter(
            all
              .filter((file) => path.basename(file) === 'tsconfig.json')
              .map((file) => path.resolve(cwd, file)),
            (candidate) => fs.exists(candidate),
            { concurrency: 'unbounded' },
          ),
        ),
      ],
      { concurrency: 'unbounded' },
    )

    if (tsconfigs.length === 0) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no tsconfig.json found' }))
    }

    const selected = targets === undefined ? tsconfigs : yield* selectTsconfigs(tsconfigs, targets)

    if (selected.length === 0) {
      return yield* Effect.fail(
        new NothingToCheck({ reason: 'no tsconfig.json covers the given files' }),
      )
    }

    if (typescript === undefined) {
      return yield* Effect.fail(
        new CannotCheck({
          reason: `found ${selected.length} tsconfig.json but typescript is not installed`,
        }),
      )
    }

    const bin = typescript

    const projects = new Map<string, TsProject>()
    const queue = [...selected]

    while (queue.length > 0) {
      const configPath = queue.pop()!

      if (!projects.has(configPath)) {
        const references = yield* readReferences(configPath)

        projects.set(configPath, { path: configPath, references })
        queue.push(...references)
      }
    }

    const plan = yield* planTypecheck(selected, projects).pipe(
      Effect.catchTag('CircularProjectReferences', (error) => {
        const cycle = error.projects
          .map((configPath) => path.relative(cwd, configPath) || '.')
          .join(', ')
        return Effect.fail(
          new CannotCheck({ reason: `circular project references between ${cycle}` }),
        )
      }),
    )

    const commands: CheckCommand[] = []

    if (plan.build.length > 0) {
      commands.push({
        bin,
        args: ['-b', ...plan.build.map((configPath) => path.relative(cwd, configPath) || '.')],
      })
    }

    for (const configPath of plan.check) {
      commands.push({ bin, args: ['-p', path.relative(cwd, configPath) || '.'] })
    }

    return commands
  }),
}

const CHECKABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
])

interface TsProject {
  readonly path: string
  readonly references: ReadonlyArray<string>
}

interface TypecheckPlan {
  readonly build: ReadonlyArray<string>
  readonly check: ReadonlyArray<string>
}

class CircularProjectReferences extends Data.TaggedError('CircularProjectReferences')<{
  readonly projects: ReadonlyArray<string>
}> {}

/**
 * Splits the discovered `entries` into what `tsc -b` must build and what `tsc -p` can check on its own.
 *
 * Every project that has references, or is referenced, belongs to the build graph.
 * Only the graph's roots are passed to `tsc -b` since it builds their references transitively.
 */
function planTypecheck(
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

  const nodes = [...members].sort()

  const graph = Graph.directed<string, null>((mutable) => {
    const indexes = new Map(nodes.map((node) => [node, Graph.addNode(mutable, node)] as const))

    for (const node of nodes) {
      for (const reference of projects.get(node)?.references ?? []) {
        Graph.addEdge(mutable, indexes.get(node)!, indexes.get(reference)!, null)
      }
    }
  })

  const cycle = Graph.findCycle(graph)

  if (Option.isSome(cycle)) {
    // The path closes on its first node, drop that repetition.
    const path = cycle.value.path
      .slice(0, -1)
      .map((index) => Option.getOrThrow(Graph.getNode(graph, index)))

    return Effect.fail(new CircularProjectReferences({ projects: path }))
  }

  return Effect.succeed({
    build: nodes.filter((member) => !referenced.has(member)),
    check: entries.filter((entry) => !members.has(entry)).sort(),
  })
}

function selectTsconfigs(
  entries: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.filter(
    entries,
    (entry) =>
      Effect.map(loadTsconfigInputs(entry), (inputs) =>
        files.some((file) => includesFile(inputs, file)),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((selected) => [...selected].sort()))
}

interface RawTsconfig {
  readonly extends?: unknown
  readonly files?: unknown
  readonly include?: unknown
  readonly exclude?: unknown
  readonly references?: unknown
  readonly compilerOptions?: unknown
}

/** Parses a config file as JSONC. Unreadable or malformed files read as empty and are left for `tsc` to report. */
const readTsconfig = Effect.fn(
  function* (configPath: string) {
    const fs = yield* FileSystem.FileSystem
    const value: unknown = parseJsonc(yield* fs.readFileString(configPath), undefined, {
      allowTrailingComma: true,
    })

    return Predicate.isObject(value) ? value : {}
  },
  Effect.orElseSucceed((): RawTsconfig => ({})),
)

/** `references` are never inherited through `extends`, so only the file itself is read. */
const readReferences = Effect.fn(function* (configPath: string) {
  const path = yield* Path.Path
  const configDir = path.dirname(configPath)
  const { references } = yield* readTsconfig(configPath)

  return (Array.isArray(references) ? references : []).flatMap((reference: unknown) => {
    if (!Predicate.isObject(reference) || typeof reference.path !== 'string') {
      return []
    }

    const target = path.resolve(configDir, reference.path.replaceAll(CONFIG_DIR, configDir))

    return [target.endsWith('.json') ? target : path.join(target, 'tsconfig.json')]
  })
})

interface InputPattern {
  readonly spec: string
  readonly regex: RegExp
}

interface TsconfigInputs {
  readonly dir: string
  readonly files: ReadonlyArray<string>
  readonly include: ReadonlyArray<InputPattern>
  readonly exclude: ReadonlyArray<InputPattern>
  readonly extensions: ReadonlySet<string>
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs']
const DEFAULT_EXCLUDES = ['node_modules', 'bower_components', 'jspm_packages']

interface Specs {
  readonly dir: string
  readonly specs: ReadonlyArray<string>
}

/**
 * Resolves `files`, `include`, `exclude` and the relevant compiler options of a config the way
 * `tsc` does: each field comes from the last config in the `extends` chain that sets it, relative
 * paths resolve against the config that set them, and `${configDir}` means the leaf config's folder.
 */
const loadTsconfigInputs = Effect.fn(function* (configPath: string) {
  const path = yield* Path.Path
  const chain = yield* loadExtendsChain(configPath, new Set())
  const leafDir = path.dirname(configPath)

  let files: Specs | undefined
  let include: Specs | undefined
  let exclude: Specs | undefined
  let outDir: Specs | undefined
  let allowJs = false

  for (const { dir, raw } of chain) {
    if (isStringArray(raw.files)) {
      files = { dir, specs: raw.files }
    }

    if (isStringArray(raw.include)) {
      include = { dir, specs: raw.include }
    }

    if (isStringArray(raw.exclude)) {
      exclude = { dir, specs: raw.exclude }
    }

    if (Predicate.isObject(raw.compilerOptions)) {
      const { compilerOptions } = raw

      if (typeof compilerOptions.allowJs === 'boolean') {
        allowJs = compilerOptions.allowJs
      }

      if (compilerOptions.checkJs === true) {
        allowJs = true
      }

      if (typeof compilerOptions.outDir === 'string') {
        outDir = { dir, specs: [compilerOptions.outDir] }
      }
    }
  }

  const resolve = (specs: Specs | undefined): string[] =>
    specs?.specs.map((spec) =>
      path.resolve(specs.dir, spec.replaceAll(CONFIG_DIR, leafDir)).replaceAll('\\', '/'),
    ) ?? []

  const includeSpecs =
    include === undefined && files === undefined
      ? [`${leafDir.replaceAll('\\', '/')}/**/*`]
      : resolve(include)

  const excludeSpecs =
    exclude === undefined
      ? [
          ...DEFAULT_EXCLUDES.map((name) => `${leafDir.replaceAll('\\', '/')}/${name}`),
          ...resolve(outDir),
        ]
      : resolve(exclude)

  return {
    dir: leafDir,
    files: resolve(files),
    include: includeSpecs.flatMap((spec) => {
      const regex = compileGlob(spec, 'files')
      return regex === undefined ? [] : [{ spec, regex }]
    }),
    exclude: excludeSpecs.map((spec) => ({ spec, regex: compileGlob(spec, 'exclude')! })),
    extensions: new Set(allowJs ? [...TS_EXTENSIONS, ...JS_EXTENSIONS] : TS_EXTENSIONS),
  }
})

function includesFile(inputs: TsconfigInputs, file: string): boolean {
  const target = file.replaceAll('\\', '/')

  if (inputs.files.includes(target)) {
    return true
  }

  const extension = posix.extname(target).toLowerCase()
  const json = extension === '.json'

  if (!json && !inputs.extensions.has(extension)) {
    return false
  }

  if (inputs.exclude.some((pattern) => pattern.regex.test(target))) {
    return false
  }

  // JSON files only come in through an `include` that names the extension explicitly.
  return inputs.include.some(
    (pattern) => pattern.regex.test(target) && (!json || pattern.spec.endsWith('.json')),
  )
}

interface ChainEntry {
  readonly dir: string
  readonly raw: RawTsconfig
}

const loadExtendsChain = Effect.fn(function* (
  configPath: string,
  visited: Set<string>,
): Effect.fn.Return<ReadonlyArray<ChainEntry>, never, FileSystem.FileSystem | Path.Path> {
  if (visited.has(configPath)) {
    return []
  }

  visited.add(configPath)

  const path = yield* Path.Path
  const raw = yield* readTsconfig(configPath)
  const dir = path.dirname(configPath)
  const specs =
    typeof raw.extends === 'string' ? [raw.extends] : isStringArray(raw.extends) ? raw.extends : []

  const bases = yield* Effect.forEach(specs, (spec) =>
    resolveExtends(spec, dir).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<ReadonlyArray<ChainEntry>>([]),
          onSome: (base) => loadExtendsChain(base, visited),
        }),
      ),
    ),
  )

  return [...bases.flat(), { dir, raw }]
})

const resolveExtends = Effect.fn(function* (spec: string, dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const kind = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => undefined),
    )

  const firstFile = (candidates: ReadonlyArray<string>) =>
    Effect.findFirst(candidates, (candidate) =>
      Effect.map(kind(candidate), (type) => type === 'File'),
    )

  if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
    const target = path.resolve(dir, spec)
    return yield* firstFile([target, `${target}.json`])
  }

  const [name, subpath] = splitPackageSpec(spec)

  for (const current of ancestors(path, dir)) {
    const pkg = path.join(current, 'node_modules', name)
    const pkgManifest = yield* readJson(path.join(pkg, 'package.json'))

    // Like tsc, a package that declares `exports` is reachable only through them.
    if (pkgManifest?.exports !== undefined) {
      const target = resolveExports(pkgManifest.exports, subpath)
      return target === undefined ? Option.none() : yield* firstFile([path.resolve(pkg, target)])
    }

    const base = path.join(current, 'node_modules', spec)
    const baseKind = yield* kind(base)

    if (baseKind === 'File') {
      return Option.some(base)
    }

    const candidates = [`${base}.json`]

    if (baseKind === 'Directory') {
      const manifest = yield* readJson(path.join(base, 'package.json'))
      candidates.push(
        path.resolve(
          base,
          typeof manifest?.tsconfig === 'string' ? manifest.tsconfig : 'tsconfig.json',
        ),
      )
    }

    const found = yield* firstFile(candidates)

    if (Option.isSome(found)) {
      return found
    }
  }

  return Option.none()
})

const IMPLICIT_EXCLUDE = '(?!(?:node_modules|bower_components|jspm_packages)(?:/|$))'
const FILES_DOUBLE_ASTERISK = `(?:/${IMPLICIT_EXCLUDE}[^/.][^/]*)*?`
const EXCLUDE_DOUBLE_ASTERISK = '(?:/.+?)?'
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Turns an absolute `include` or `exclude` pattern into the regular expression `tsc` uses for it:
 * `*` and `?` never cross a directory, a leading wildcard never matches a dot file, `**` skips
 * `node_modules` and dot folders, and a pattern without extension or wildcard means the whole folder.
 * `exclude` patterns also match every path below them.
 */
function compileGlob(pattern: string, usage: 'files' | 'exclude'): RegExp | undefined {
  const components = pattern.replace(/\/+$/, '').split('/')
  const last = components[components.length - 1]!

  if (usage === 'files' && last === '**') {
    return undefined
  }

  if (!/[*?.]/.test(last)) {
    components.push('**', '*')
  }

  let source = ''
  let written = false

  for (const component of components) {
    if (component === '**') {
      source += usage === 'files' ? FILES_DOUBLE_ASTERISK : EXCLUDE_DOUBLE_ASTERISK
    } else {
      if (written) {
        source += '/'
      }

      source += usage === 'files' ? filesComponent(component) : wildcards(component)
    }

    written = true
  }

  return new RegExp(
    `^${source}${usage === 'exclude' ? '(?:$|/)' : '$'}`,
    CASE_INSENSITIVE ? 'i' : '',
  )
}

function filesComponent(component: string): string {
  let source = ''
  let rest = component

  if (rest.startsWith('*')) {
    source += '(?:[^./][^/]*)?'
    rest = rest.slice(1)
  } else if (rest.startsWith('?')) {
    source += '[^./]'
    rest = rest.slice(1)
  }

  source += wildcards(rest)

  return /[*?]/.test(component) ? IMPLICIT_EXCLUDE + source : source
}

function wildcards(component: string): string {
  return component.replace(/[.*?+^${}()|[\]\\]/g, (char) =>
    char === '*' ? '[^/]*' : char === '?' ? '[^/]' : `\\${char}`,
  )
}

/** Splits `@scope/pkg/sub/path` into the package name and its `exports` subpath, `.` or `./sub/path`. */
function splitPackageSpec(spec: string): readonly [name: string, subpath: string] {
  const parts = spec.split('/')
  const length = spec.startsWith('@') ? 2 : 1
  const rest = parts.slice(length).join('/')

  return [parts.slice(0, length).join('/'), rest === '' ? '.' : `./${rest}`]
}

/** The conditions tsc matches when it resolves `extends` through `exports`. */
const EXPORT_CONDITIONS = new Set(['node', 'require', 'types', 'default'])

/**
 * The file a package's `exports` maps `subpath` to, following exact keys, `*` patterns (the longest
 * prefix wins) and condition objects, or `undefined` when the subpath is not exported.
 */
function resolveExports(exports: unknown, subpath: string): string | undefined {
  const map: Record<string, unknown> =
    Predicate.isObject(exports) &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith('.'))
      ? exports
      : { '.': exports }

  if (Object.hasOwn(map, subpath)) {
    return exportTarget(map[subpath], undefined)
  }

  let best: { prefix: string; match: string; target: unknown } | undefined

  for (const [key, target] of Object.entries(map)) {
    const star = key.indexOf('*')
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)

    if (
      star !== -1 &&
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (best === undefined || prefix.length > best.prefix.length)
    ) {
      best = { prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length), target }
    }
  }

  return best && exportTarget(best.target, best.match)
}

function exportTarget(target: unknown, match: string | undefined): string | undefined {
  if (typeof target === 'string') {
    return match === undefined ? target : target.replaceAll('*', match)
  }

  const candidates = Array.isArray(target)
    ? target
    : Predicate.isObject(target)
      ? Object.entries(target)
          .filter(([condition]) => EXPORT_CONDITIONS.has(condition))
          .map(([, value]) => value)
      : []

  for (const candidate of candidates) {
    const resolved = exportTarget(candidate, match)

    if (resolved !== undefined) {
      return resolved
    }
  }

  return undefined
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
