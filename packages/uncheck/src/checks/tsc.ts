import { posix } from 'node:path'

import { Effect, FileSystem, Option, Path, Predicate } from 'effect'
import { parse as parseJsonc } from 'jsonc-parser'

import { CannotCheck, NothingToCheck } from '../errors'
import { ancestors, readJson } from '../files'
import type { Bin } from '../tool'
import { resolveBin } from '../tool'
import type { Check } from '../types'

/**
 * TypeScript replaces this token at the start of `files`, `include`, `exclude` and path-valued
 * compiler options with the folder of the leaf config, but never in `extends` or `references`.
 */
// oxlint-disable-next-line no-template-curly-in-string
const CONFIG_DIR = '${configDir}'

function notCovered(
  typescript: Bin | undefined,
  files: ReadonlyArray<string> | undefined,
): NothingToCheck {
  return new NothingToCheck({
    reason: `no tsconfig.json covers ${files === undefined ? 'this folder' : 'the given files'}`,
    unrelated: typescript !== undefined,
  })
}

/**
 * Composite projects still write their `.tsbuildinfo` under `--noEmit`, and without `composite`,
 * `emitDeclarationOnly` fails unless `declaration` is set.
 */
const WITHOUT_BUILD_INFO = ['--composite', 'false', '--declaration']

export const tsc: Check = {
  name: 'tsc',
  fixes: false,
  plan: Effect.fn(function* ({ cwd, files, deleted, projectFiles }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const checkable = (relativeFiles: ReadonlyArray<string>) =>
      relativeFiles
        .map((file) => path.resolve(cwd, file))
        .filter((file) => CHECKABLE_EXTENSIONS.has(posix.extname(file)))

    // Deleted files are among the targets, so selecting a project must never need one on disk.
    const given = files === undefined ? undefined : checkable([...files, ...deleted])

    if (given !== undefined && given.length === 0) {
      return yield* Effect.fail(notCovered(yield* resolveBin('typescript', cwd, 'tsc'), files))
    }

    const [typescript, tracked] = yield* Effect.all(
      [
        resolveBin('typescript', cwd, 'tsc'),
        Effect.flatMap(projectFiles, (all) =>
          // Tracked files can be deleted from the working tree without being staged yet, while a
          // path `exists` cannot reach is left for tsc to report.
          Effect.filter(
            all
              .filter((file) => path.basename(file) === 'tsconfig.json')
              .map((file) => path.resolve(cwd, file)),
            (candidate) => fs.exists(candidate).pipe(Effect.orElseSucceed(() => true)),
            { concurrency: 'unbounded' },
          ),
        ),
      ],
      { concurrency: 'unbounded' },
    )

    const inherited =
      tracked.length > 0
        ? undefined
        : Option.getOrUndefined(
            yield* firstFile(
              ancestors(path, path.dirname(cwd)).map((dir) => path.join(dir, 'tsconfig.json')),
            ),
          )

    if (inherited === undefined && tracked.length === 0) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no tsconfig.json found' }))
    }

    // A config above the folder may cover far more than it, so even a full run selects by its files.
    const targets = given ?? (inherited === undefined ? undefined : checkable(yield* projectFiles))

    const references = new Map<string, ReadonlyArray<string>>()
    const queue = inherited === undefined ? [...tracked] : [inherited]

    while (queue.length > 0) {
      const configPath = queue.pop()!

      if (!references.has(configPath) && (yield* fileKind(configPath)) === 'File') {
        const referencedConfigs = yield* readReferences(configPath)

        references.set(configPath, referencedConfigs)
        queue.push(...referencedConfigs)
      }
    }

    const selected =
      targets === undefined
        ? tracked
        : yield* selectTsconfigs(
            references,
            targets,
            deleted.map((file) => path.resolve(cwd, file)),
          )

    if (selected.length === 0) {
      return yield* Effect.fail(notCovered(typescript, files))
    }

    const projects =
      targets === undefined
        ? selected
        : [
            ...new Set([
              ...selected,
              ...(yield* workspaceDependents(
                [...references.keys()],
                selected,
                (yield* projectFiles)
                  .filter((file) => path.basename(file) === 'package.json')
                  .map((file) => path.resolve(cwd, file)),
              )),
            ]),
          ]

    if (typescript === undefined) {
      return yield* Effect.fail(
        new CannotCheck({
          reason: `found ${projects.length} tsconfig.json but typescript is not installed`,
        }),
      )
    }

    const shown = (configPath: string) => {
      const relative = path.relative(cwd, configPath)

      // tsc reads an argument starting with `-` as an option and one starting with `@` as a file of
      // arguments, even after `-b`.
      return /^[-@]/.test(relative) ? `./${relative}` : relative
    }
    const referenced = new Set([...references.values()].flat())
    const members = [...references]
      .filter(
        ([configPath, referencedConfigs]) =>
          referencedConfigs.length > 0 || referenced.has(configPath),
      )
      .map(([configPath]) => configPath)
      .sort()

    const cycle = findCycle(members, references)

    if (cycle !== undefined) {
      return yield* Effect.fail(
        new CannotCheck({
          reason: `circular project references between ${cycle.map(shown).join(', ')}`,
        }),
      )
    }

    const dependents = new Map<string, string[]>()

    for (const [dependent, referencedConfigs] of references) {
      for (const configPath of referencedConfigs) {
        const known = dependents.get(configPath) ?? []

        known.push(dependent)
        dependents.set(configPath, known)
      }
    }

    const affected = new Set(targets === undefined ? references.keys() : projects)

    for (const configPath of affected) {
      for (const dependent of dependents.get(configPath) ?? []) {
        affected.add(dependent)
      }
    }

    const roots = members.filter((member) => !referenced.has(member) && affected.has(member))
    const extended = yield* extendedConfigs([...references.keys()])
    const allFiles = yield* projectFiles
    const standalone = yield* Effect.filter(
      projects.filter((configPath) => !members.includes(configPath)),
      (configPath) =>
        Effect.map(isSharedBase(configPath, extended, cwd, allFiles), (shared) => !shared),
      { concurrency: 'unbounded' },
    )
    const built: string[] = []
    const checkedAlone = new Map<string, ReadonlyArray<string>>(
      standalone.map((configPath) => [configPath, []]),
    )

    for (const root of roots) {
      const graph = new Set([root])

      for (const configPath of graph) {
        for (const referencedConfig of references.get(configPath)!) {
          if (references.has(referencedConfig)) {
            graph.add(referencedConfig)
          }
        }
      }

      const graphInputs = yield* Effect.forEach(
        graph,
        (configPath) =>
          Effect.map(loadTsconfigInputs(configPath), (inputs) => ({ configPath, inputs })),
        { concurrency: 'unbounded' },
      )

      // `tsc -b` would write JavaScript next to the sources of such a project, and Vite, for one,
      // then loads a stale vite.config.js instead of vite.config.ts.
      if (graphInputs.some(({ inputs }) => hasInputs(inputs) && inputs.emitsBesideSources)) {
        for (const { configPath, inputs } of graphInputs) {
          if (affected.has(configPath) && hasInputs(inputs)) {
            checkedAlone.set(configPath, inputs.composite ? WITHOUT_BUILD_INFO : [])
          }
        }
      } else {
        built.push(root)
      }
    }

    if (built.length === 0 && checkedAlone.size === 0) {
      return yield* Effect.fail(notCovered(typescript, files))
    }

    return [
      ...(built.length > 0 ? [{ bin: typescript, args: ['-b', ...built.map(shown)] }] : []),
      // `-p` would emit JavaScript next to sources that set no `noEmit`.
      ...[...checkedAlone.keys()].sort().map((configPath) => ({
        bin: typescript,
        args: ['-p', shown(configPath), '--noEmit', ...checkedAlone.get(configPath)!],
        parallel: true,
      })),
    ]
  }),
}

/** The configs other configs extend, by their real path, as an extends through a workspace link names the link. */
const extendedConfigs = Effect.fn(function* (configPaths: ReadonlyArray<string>) {
  const chains = yield* Effect.forEach(
    configPaths,
    (configPath) => loadExtendsChain(configPath, new Set()),
    { concurrency: 'unbounded' },
  )

  return new Set(
    yield* Effect.forEach(
      chains.flatMap((chain) => chain.slice(0, -1)),
      ({ file }) => realPath(file),
      { concurrency: 'unbounded' },
    ),
  )
})

/**
 * A shared base kept as a tsconfig.json, the way `@tsconfig/bases` packages ship theirs, has no
 * sources of its own: tsc fails it with TS18003, and the configs extending it are checked anyway.
 */
const isSharedBase = Effect.fn(function* (
  configPath: string,
  extended: ReadonlySet<string>,
  cwd: string,
  files: ReadonlyArray<string>,
) {
  const path = yield* Path.Path

  if (!extended.has(yield* realPath(configPath))) {
    return false
  }

  const inputs = yield* loadTsconfigInputs(configPath)

  return !files.some((file) => includesFile(inputs, path.resolve(cwd, file)))
})

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/**
 * The configs of the workspace packages that depend, directly or through others, on a package that
 * owns one of `selected`: a package imported through its workspace link needs no project reference.
 */
const workspaceDependents = Effect.fn(function* (
  candidates: ReadonlyArray<string>,
  selected: ReadonlyArray<string>,
  manifests: ReadonlyArray<string>,
) {
  const path = yield* Path.Path
  const packages = yield* Effect.forEach(
    manifests,
    (manifestPath) =>
      Effect.map(readJson(manifestPath), (manifest) => ({
        dir: path.dirname(manifestPath),
        name: manifest?.name,
        dependencies: DEPENDENCY_FIELDS.flatMap((field) => {
          const versions = manifest?.[field]
          return Predicate.isObject(versions) ? Object.keys(versions) : []
        }),
      })),
    // A manifest that fails to open for want of file descriptors would silently drop its package.
    { concurrency: 64 },
  )
  const packageDirs = new Set(packages.map(({ dir }) => dir))
  const ownerOf = (configPath: string) =>
    ancestors(path, path.dirname(configPath)).find((dir) => packageDirs.has(dir))

  const owners = new Set(selected.map(ownerOf))
  const reachedNames = new Set(
    packages.filter(({ dir }) => owners.has(dir)).map(({ name }) => name),
  )
  const dependentDirs = new Set<string>()

  for (let grown = true; grown;) {
    grown = false

    for (const { dir, name, dependencies } of packages) {
      if (
        !dependentDirs.has(dir) &&
        dependencies.some((dependency) => reachedNames.has(dependency))
      ) {
        dependentDirs.add(dir)
        reachedNames.add(name)
        grown = true
      }
    }
  }

  return candidates.filter((configPath) => {
    const owner = ownerOf(configPath)
    return owner !== undefined && dependentDirs.has(owner)
  })
})

function findCycle(
  nodes: ReadonlyArray<string>,
  references: ReadonlyMap<string, ReadonlyArray<string>>,
  trail: ReadonlyArray<string> = [],
  done = new Set<string>(),
): ReadonlyArray<string> | undefined {
  for (const node of nodes) {
    if (trail.includes(node)) {
      return trail.slice(trail.indexOf(node))
    }

    if (!done.has(node)) {
      const cycle = findCycle(references.get(node) ?? [], references, [...trail, node], done)

      done.add(node)

      if (cycle !== undefined) {
        return cycle
      }
    }
  }

  return undefined
}

const selectTsconfigs = Effect.fn(function* (
  references: ReadonlyMap<string, ReadonlyArray<string>>,
  files: ReadonlyArray<string>,
  deleted: ReadonlyArray<string>,
) {
  const jsonFiles = yield* Effect.forEach(
    files.filter((file) => posix.extname(file) === '.json'),
    realPath,
    { concurrency: 'unbounded' },
  )

  return yield* Effect.filter(
    [...references.keys()],
    (candidate) =>
      // A deleted config is no candidate, so only the configs that reference it lead to its dependents.
      references.get(candidate)!.some((config) => deleted.includes(config))
        ? Effect.succeed(true)
        : Effect.flatMap(loadTsconfigInputs(candidate), (inputs) =>
            files.some((file) => includesFile(inputs, file))
              ? Effect.succeed(true)
              : jsonFiles.length === 0
                ? Effect.succeed(false)
                : Effect.map(
                    Effect.forEach(inputs.configs, realPath, { concurrency: 'unbounded' }),
                    (configs) => configs.some((config) => jsonFiles.includes(config)),
                  ),
          ),
    { concurrency: 'unbounded' },
  )
})

/**
 * A shared config is often extended through a workspace package linked into `node_modules`, while
 * the given files name it by its real path.
 */
const realPath = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem

  return yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => file))
})

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

    const target = path.resolve(configDir, reference.path.replaceAll('\\', '/'))

    return [target.endsWith('.json') ? target : path.join(target, 'tsconfig.json')]
  })
})

interface InputPattern {
  readonly spec: string
  readonly matches: (file: string) => boolean
}

interface TsconfigInputs {
  readonly configs: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
  readonly include: ReadonlyArray<InputPattern>
  readonly exclude: ReadonlyArray<InputPattern>
  readonly extensions: ReadonlySet<string>
  /** Neither `noEmit`, `emitDeclarationOnly`, `outDir` nor `outFile` keeps the output away from the sources. */
  readonly emitsBesideSources: boolean
  readonly composite: boolean
}

function hasInputs(inputs: TsconfigInputs): boolean {
  return inputs.files.length > 0 || inputs.include.length > 0
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs']
const CHECKABLE_EXTENSIONS = new Set([...TS_EXTENSIONS, ...JS_EXTENSIONS, '.json'])

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

  const last: Partial<
    Record<'files' | 'include' | 'exclude' | 'outDir' | 'declarationDir' | 'outFile', Specs>
  > = {}
  const flags = { allowJs: false, noEmit: false, emitDeclarationOnly: false, composite: false }

  for (const { dir, raw } of chain) {
    for (const key of ['files', 'include', 'exclude'] as const) {
      const specs = raw[key]

      if (isStringArray(specs)) {
        last[key] = { dir, specs }
      }
    }

    if (Predicate.isObject(raw.compilerOptions)) {
      const { compilerOptions } = raw

      for (const key of ['outDir', 'declarationDir', 'outFile'] as const) {
        const spec = compilerOptions[key]

        if (typeof spec === 'string') {
          last[key] = { dir, specs: [spec] }
        }
      }

      for (const key of ['allowJs', 'noEmit', 'emitDeclarationOnly', 'composite'] as const) {
        const value = compilerOptions[key]

        if (typeof value === 'boolean') {
          flags[key] = value
        }
      }

      if (compilerOptions.checkJs === true) {
        flags.allowJs = true
      }
    }
  }

  const { files, include, exclude, outDir, declarationDir, outFile } = last
  const { allowJs, noEmit, emitDeclarationOnly, composite } = flags

  const resolve = (specs: Specs | undefined): string[] =>
    specs?.specs.map((spec) =>
      path
        .resolve(specs.dir, spec.replaceAll('\\', '/').replaceAll(CONFIG_DIR, leafDir))
        .replaceAll('\\', '/'),
    ) ?? []

  const includeSpecs =
    include === undefined && files === undefined
      ? [`${leafDir.replaceAll('\\', '/')}/**/*`]
      : resolve(include)

  const excludeSpecs =
    exclude === undefined ? [...resolve(outDir), ...resolve(declarationDir)] : resolve(exclude)

  return {
    configs: chain.map(({ file }) => file),
    files: resolve(files),
    include: includeSpecs.flatMap((spec) => {
      const matches = compileGlob(spec, 'files')
      return matches === undefined ? [] : [{ spec, matches }]
    }),
    exclude: excludeSpecs.map((spec) => ({ spec, matches: compileGlob(spec, 'exclude')! })),
    extensions: new Set(allowJs ? [...TS_EXTENSIONS, ...JS_EXTENSIONS] : TS_EXTENSIONS),
    emitsBesideSources:
      !noEmit && !emitDeclarationOnly && outDir === undefined && outFile === undefined,
    composite,
  }
})

function includesFile(inputs: TsconfigInputs, file: string): boolean {
  const target = file.replaceAll('\\', '/')

  if (inputs.files.includes(target)) {
    return true
  }

  const extension = posix.extname(target)
  const json = extension === '.json'

  if (!json && !inputs.extensions.has(extension)) {
    return false
  }

  if (inputs.exclude.some((pattern) => pattern.matches(target))) {
    return false
  }

  // JSON files only come in through an `include` that names the extension explicitly.
  return inputs.include.some(
    (pattern) => pattern.matches(target) && (!json || pattern.spec.endsWith('.json')),
  )
}

interface ChainEntry {
  readonly file: string
  readonly dir: string
  readonly raw: RawTsconfig
}

/**
 * Only a config that is still being resolved closes a cycle: like tsc, a base that two `extends`
 * branches share applies in both.
 */
const loadExtendsChain = Effect.fn(function* (
  configPath: string,
  resolving: ReadonlySet<string>,
): Effect.fn.Return<ReadonlyArray<ChainEntry>, never, FileSystem.FileSystem | Path.Path> {
  if (resolving.has(configPath)) {
    return []
  }

  const path = yield* Path.Path
  const raw = yield* readTsconfig(configPath)
  const dir = path.dirname(configPath)
  const specs =
    typeof raw.extends === 'string' ? [raw.extends] : isStringArray(raw.extends) ? raw.extends : []

  const bases = yield* Effect.forEach(specs, (spec) =>
    resolveExtends(spec.replaceAll('\\', '/'), dir).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<ReadonlyArray<ChainEntry>>([]),
          onSome: (base) => loadExtendsChain(base, new Set(resolving).add(configPath)),
        }),
      ),
    ),
  )

  return [...bases.flat(), { file: configPath, dir, raw }]
})

const fileKind = Effect.fn(function* (target: string) {
  const fs = yield* FileSystem.FileSystem

  return yield* fs.stat(target).pipe(
    Effect.map((info) => info.type),
    Effect.orElseSucceed(() => undefined),
  )
})

const firstFile = (candidates: ReadonlyArray<string>) =>
  Effect.findFirst(candidates, (candidate) =>
    Effect.map(fileKind(candidate), (type) => type === 'File'),
  )

const resolveExtends = Effect.fn(function* (spec: string, dir: string) {
  const path = yield* Path.Path

  if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
    const target = path.resolve(dir, spec)

    // A deleted base must still select the configs that extend it.
    return Option.orElseSome(yield* firstFile([target, `${target}.json`]), () =>
      target.endsWith('.json') ? target : `${target}.json`,
    )
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
    const baseKind = yield* fileKind(base)

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
const FILES_ASTERISK = '(?:[^./]|(?:\\.(?!min\\.js$))?)*'
const FILES_DOUBLE_ASTERISK = `(?:/${IMPLICIT_EXCLUDE}[^/.][^/]*)*?`
const EXCLUDE_DOUBLE_ASTERISK = '(?:/.+?)?'

/**
 * Turns an absolute `include` or `exclude` pattern into the regular expression `tsc` uses for it:
 * `*` and `?` never cross a directory, a leading wildcard never matches a dot file, `**` skips
 * `node_modules` and dot folders, and a pattern without extension or wildcard means the whole folder.
 * In `include`, `*` never matches a name ending in `.min.js`; `exclude` patterns also match every
 * path below them.
 */
function compileGlob(
  pattern: string,
  usage: 'files' | 'exclude',
): ((file: string) => boolean) | undefined {
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

  // tsc ignores case on file systems that do, even in the lookaheads that keep node_modules and .min.js
  // out, so `include` matches the way tsc does on either kind and `exclude` keeps case: on any file
  // system that selects every project tsc would check, and at worst one more.
  const regexes =
    usage === 'files'
      ? [new RegExp(`^${source}$`), new RegExp(`^${source}$`, 'i')]
      : [new RegExp(`^${source}(?:$|/)`)]

  return (file) => regexes.some((regex) => regex.test(file))
}

function filesComponent(component: string): string {
  let source = ''
  let rest = component

  if (rest.startsWith('*')) {
    source += `(?:[^./]${FILES_ASTERISK})?`
    rest = rest.slice(1)
  } else if (rest.startsWith('?')) {
    source += '[^./]'
    rest = rest.slice(1)
  }

  source += wildcards(rest, FILES_ASTERISK)

  return /[*?]/.test(component) ? IMPLICIT_EXCLUDE + source : source
}

function wildcards(component: string, asterisk = '[^/]*'): string {
  return component.replace(/[.*?+^${}()|[\]\\]/g, (char) =>
    char === '*' ? asterisk : char === '?' ? '[^/]' : `\\${char}`,
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
    Predicate.isObject(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
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
