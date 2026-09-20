import process from 'node:process'
import { Effect, FileSystem, Option, Path } from 'effect'
import { parse as parseJsonc } from 'jsonc-parser'

export interface RawTsconfig {
  readonly extends?: unknown
  readonly files?: unknown
  readonly include?: unknown
  readonly exclude?: unknown
  readonly references?: unknown
  readonly compilerOptions?: unknown
}

/** Parses a config file as JSONC. Unreadable or malformed files read as empty and are left for `tsc` to report. */
export function readTsconfig(configPath: string): Effect.Effect<RawTsconfig, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.readFileString(configPath).pipe(
      Effect.map(text => parseJsonc(text, undefined, { allowTrailingComma: true }) as unknown),
      Effect.map((value): RawTsconfig => (isRecord(value) ? value : {})),
      Effect.orElseSucceed((): RawTsconfig => ({})),
    )
  })
}

/**
 * The `references` of one config file, resolved like `tsc` does: relative to the config's directory,
 * and a path without a `.json` extension means that folder's `tsconfig.json`.
 * `references` are never inherited through `extends`, so the file itself is all that matters.
 */
export function readReferences(
  configPath: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const configDir = path.dirname(configPath)
    const { references } = yield* readTsconfig(configPath)

    return (Array.isArray(references) ? references : []).flatMap((reference: unknown) => {
      if (!isRecord(reference) || typeof reference.path !== 'string') {
        return []
      }

      const target = path.resolve(configDir, reference.path.replaceAll('${configDir}', configDir))

      return [target.endsWith('.json') ? target : path.join(target, 'tsconfig.json')]
    })
  })
}

export interface InputPattern {
  /** Absolute pattern with forward slashes. */
  readonly spec: string
  readonly regex: RegExp
  /** Absolute directory before the first wildcard. */
  readonly prefix: string
}

/** What `tsc` would take as input files for one project, with `extends` applied. */
export interface TsconfigInputs {
  readonly dir: string
  /** Absolute paths listed in `files`, always included. */
  readonly files: ReadonlyArray<string>
  readonly include: ReadonlyArray<InputPattern>
  readonly exclude: ReadonlyArray<InputPattern>
  /** Extensions `tsc` picks up through `include`, JSON aside. */
  readonly extensions: ReadonlySet<string>
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs']
const DEFAULT_EXCLUDES = ['node_modules', 'bower_components', 'jspm_packages']

interface Specs {
  /** Directory of the config that defined the specs, which relative specs resolve against. */
  readonly dir: string
  readonly specs: ReadonlyArray<string>
}

/**
 * Resolves `files`, `include`, `exclude` and the relevant compiler options of a config the way
 * `tsc` does: each field comes from the last config in the `extends` chain that sets it, relative
 * paths resolve against the config that set them, and `${configDir}` means the leaf config's folder.
 */
export function loadTsconfigInputs(
  configPath: string,
): Effect.Effect<TsconfigInputs, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
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

      if (isRecord(raw.compilerOptions)) {
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
      specs?.specs.map(spec => toPosix(path.resolve(specs.dir, spec.replaceAll('${configDir}', leafDir)))) ?? []

    const includeSpecs = include === undefined && files === undefined ? [`${toPosix(leafDir)}/**/*`] : resolve(include)

    const excludeSpecs =
      exclude === undefined
        ? [...DEFAULT_EXCLUDES.map(name => `${toPosix(leafDir)}/${name}`), ...resolve(outDir)]
        : resolve(exclude)

    return {
      dir: leafDir,
      files: resolve(files),
      include: includeSpecs.flatMap(spec => {
        const regex = compileGlob(spec, 'files')
        return regex === undefined ? [] : [{ spec, regex, prefix: staticPrefixDir(spec) }]
      }),
      exclude: excludeSpecs.map(spec => ({
        spec,
        regex: compileGlob(spec, 'exclude')!,
        prefix: staticPrefixDir(spec),
      })),
      extensions: new Set(allowJs ? [...TS_EXTENSIONS, ...JS_EXTENSIONS] : TS_EXTENSIONS),
    }
  })
}

/** Whether `tsc -p` on this config would take `file` as an input. */
export function includesFile(inputs: TsconfigInputs, file: string): boolean {
  const target = toPosix(file)

  if (inputs.files.includes(target)) {
    return true
  }

  const extension = extensionOf(target)
  const json = extension === '.json'

  if (!json && !inputs.extensions.has(extension)) {
    return false
  }

  if (inputs.exclude.some(pattern => pattern.regex.test(target))) {
    return false
  }

  // JSON files only come in through an `include` that names the extension explicitly.
  return inputs.include.some(pattern => pattern.regex.test(target) && (!json || pattern.spec.endsWith('.json')))
}

/** Whether some input of this config could live under `dir`, judged by where its patterns start. */
export function coversDirectory(inputs: TsconfigInputs, dir: string): boolean {
  const target = toPosix(dir)

  // Exclude patterns match the files below a folder, so probe the folder as a prefix.
  if (inputs.exclude.some(pattern => pattern.regex.test(`${target}/`))) {
    return false
  }

  return (
    inputs.files.some(file => file.startsWith(`${target}/`)) ||
    inputs.include.some(pattern => overlaps(pattern.prefix, target))
  )
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

interface ChainEntry {
  readonly dir: string
  readonly raw: RawTsconfig
}

/** Base configs first, the config itself last, so later entries override earlier ones. */
function loadExtendsChain(
  configPath: string,
  visited: Set<string>,
): Effect.Effect<ReadonlyArray<ChainEntry>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (visited.has(configPath)) {
      return []
    }

    visited.add(configPath)

    const path = yield* Path.Path
    const raw = yield* readTsconfig(configPath)
    const dir = path.dirname(configPath)
    const specs = typeof raw.extends === 'string' ? [raw.extends] : isStringArray(raw.extends) ? raw.extends : []

    const bases = yield* Effect.forEach(specs, spec =>
      resolveExtends(spec, dir).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed<ReadonlyArray<ChainEntry>>([]),
            onSome: base => loadExtendsChain(base, visited),
          }),
        ),
      ),
    )

    return [...bases.flat(), { dir, raw }]
  })
}

/** Resolves an `extends` entry: a relative path (with an optional `.json`), or a package like `tsc` looks it up. */
function resolveExtends(
  spec: string,
  dir: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const kind = (target: string) =>
      fs.stat(target).pipe(
        Effect.map(info => info.type),
        Effect.orElseSucceed(() => undefined),
      )

    const firstFile = (candidates: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        for (const candidate of candidates) {
          if ((yield* kind(candidate)) === 'File') {
            return Option.some(candidate)
          }
        }

        return Option.none<string>()
      })

    if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
      const target = path.resolve(dir, spec)
      return yield* firstFile([target, `${target}.json`])
    }

    let current = dir

    while (true) {
      const base = path.join(current, 'node_modules', spec)
      const asFile = yield* firstFile([base, `${base}.json`])

      if (Option.isSome(asFile)) {
        return asFile
      }

      if ((yield* kind(base)) === 'Directory') {
        const manifest = yield* fs.readFileString(path.join(base, 'package.json')).pipe(
          Effect.map(text => JSON.parse(text) as { tsconfig?: unknown }),
          Effect.orElseSucceed(() => ({}) as { tsconfig?: unknown }),
        )

        const entry = typeof manifest.tsconfig === 'string' ? manifest.tsconfig : 'tsconfig.json'
        const found = yield* firstFile([path.resolve(base, entry)])

        if (Option.isSome(found)) {
          return found
        }
      }

      const parent = path.dirname(current)

      if (parent === current) {
        return Option.none()
      }

      current = parent
    }
  })
}

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

  return new RegExp(`^${source}${usage === 'exclude' ? '(?:$|/)' : '$'}`, CASE_INSENSITIVE ? 'i' : '')
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

/** Escapes a path component for a regular expression, mapping `*` and `?` to their glob meaning. */
function wildcards(component: string): string {
  return component.replace(/[.*?+^${}()|[\]\\]/g, char =>
    char === '*' ? '[^/]*' : char === '?' ? '[^/]' : `\\${char}`,
  )
}

function staticPrefixDir(spec: string): string {
  const components = spec.split('/')
  const firstWildcard = components.findIndex(component => /[*?]/.test(component))

  return (firstWildcard === -1 ? components : components.slice(0, firstWildcard)).join('/')
}

function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')

  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function toPosix(target: string): string {
  return target.replaceAll('\\', '/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
