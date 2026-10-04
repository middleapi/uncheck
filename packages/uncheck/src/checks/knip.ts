import { posix } from 'node:path'

import { Effect, FileSystem, Option, Path, Predicate } from 'effect'
import { parse as parseJsonc } from 'jsonc-parser'
import { Minimatch } from 'minimatch'

import { NothingToCheck } from '../errors.ts'
import { ancestors, firstFile, inNodeModules, readJson, slashedRelative } from '../files.ts'
import { resolveBin } from '../tool.ts'
import type { Check } from '../types.ts'

/**
 * Files knip never reads, short of a compiler of the user's own: it skips imports of them, whether or
 * not they exist. It compares extensions case-sensitively, so an imported `logo.PNG` still counts.
 */
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.eot',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.png',
  '.svg',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
])

export const knip: Check = {
  name: 'knip',
  // `knip --fix` rewrites exports and manifests all over the project, and can leave broken code behind
  // while it reports success, so what knip finds is the user's to fix, like type errors.
  fixes: false,
  plan: Effect.fn(function* ({ cwd, files, deleted }) {
    const path = yield* Path.Path

    const bin = yield* resolveBin('knip', cwd)

    if (bin === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'not installed' }))
    }

    if (
      files !== undefined &&
      [...files, ...deleted].every((file) => MEDIA_EXTENSIONS.has(posix.extname(file)))
    ) {
      return yield* Effect.fail(
        new NothingToCheck({
          reason: 'only images, fonts and audio among the given files',
          unrelated: true,
        }),
      )
    }

    const manifest = yield* readJson(path.join(cwd, 'package.json'))

    // knip reads package.json only in the folder it runs in, and fails without one.
    if (manifest === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no package.json found' }))
    }

    const root = yield* enclosingWorkspace(cwd, manifest)

    // knip takes no files, since only the whole project shows what nothing uses. In a package of a
    // workspace it would take the package for a project of its own, and the dependencies installed
    // for the whole workspace for unlisted ones, so it runs at the root, reporting on the package.
    return [
      {
        bin,
        args:
          root === undefined
            ? []
            : [
                `--directory=${slashedRelative(path, cwd, root)}`,
                `--workspace=${slashedRelative(path, root, cwd)}`,
              ],
      },
    ]
  }),
}

/** Where knip looks for its config in a folder, in its order, over the `knip` field of package.json. */
const KNIP_CONFIGS = [
  'knip.json',
  'knip.jsonc',
  '.knip.json',
  '.knip.jsonc',
  'knip.ts',
  'knip.js',
  'knip.config.ts',
  'knip.config.js',
]

/**
 * The nearest workspace root above `cwd`, when that root lists `cwd` among its packages, unless
 * `cwd` is a workspace root itself or has a knip config, which knip reads only when it runs there. A
 * root has to list the package, so unlike a tsconfig.json it may be above the repository, as that of
 * a git submodule is.
 */
const enclosingWorkspace = Effect.fn(function* (
  cwd: string,
  manifest: Readonly<Record<string, unknown>>,
) {
  const path = yield* Path.Path

  if (
    manifest.knip !== undefined ||
    Option.isSome(yield* firstFile(KNIP_CONFIGS.map((name) => path.join(cwd, name)))) ||
    (yield* workspaceAt(cwd, manifest)) !== undefined
  ) {
    return undefined
  }

  for (const dir of ancestors(path, cwd).slice(1)) {
    const rootManifest = yield* readJson(path.join(dir, 'package.json'))
    // knip only runs where a package.json is.
    const workspace = rootManifest === undefined ? undefined : yield* workspaceAt(dir, rootManifest)

    if (workspace === undefined) {
      continue
    }

    const folder = slashedRelative(path, dir, cwd)

    // knip looks for the package.json of its packages outside node_modules.
    if (
      inNodeModules(folder) ||
      !matches(workspace.packages.map(manifestGlob), `${folder}/package.json`)
    ) {
      return undefined
    }

    if (matches(workspace.ignored, folder)) {
      return yield* Effect.fail(new NothingToCheck({ reason: "listed in knip's ignoreWorkspaces" }))
    }

    return dir
  }

  return undefined
})

interface Workspace {
  /** The globs of the package manager, then those knip's config sets up. */
  readonly packages: ReadonlyArray<string>
  /** The folders knip's config leaves out, apart from those it only leaves out with --production. */
  readonly ignored: ReadonlyArray<string>
}

/** The workspace `dir` is the root of as knip sees it, taking pnpm-workspace.yaml before package.json. */
const workspaceAt = Effect.fn(function* (dir: string, manifest: Readonly<Record<string, unknown>>) {
  const path = yield* Path.Path

  const yaml = yield* readText(path.join(dir, 'pnpm-workspace.yaml'))
  const config = yield* knipConfig(dir, manifest)
  const { workspaces } = manifest
  const listed: ReadonlyArray<unknown> = [
    ...(pnpmPackages(yaml) ??
      (Array.isArray(workspaces)
        ? workspaces
        : Predicate.hasProperty(workspaces, 'packages') && Array.isArray(workspaces.packages)
          ? workspaces.packages
          : [])),
    // The root is always one of knip's workspaces.
    ...(Predicate.isObject(config.workspaces)
      ? Object.keys(config.workspaces).filter((name) => name !== '.')
      : []),
  ]
  const packages = listed.filter(Predicate.isString)
  const workspace: Workspace = {
    packages,
    ignored: (Array.isArray(config.ignoreWorkspaces) ? config.ignoreWorkspaces : [])
      .filter(Predicate.isString)
      .filter((glob) => !glob.endsWith('!')),
  }

  return packages.length > 0 ? workspace : undefined
})

/** The config knip reads in `dir`: its first config file over the `knip` field of package.json. */
const knipConfig = Effect.fn(function* (dir: string, manifest: Readonly<Record<string, unknown>>) {
  const path = yield* Path.Path

  const file = Option.getOrUndefined(
    yield* firstFile(KNIP_CONFIGS.map((name) => path.join(dir, name))),
  )
  // Only knip can run a config in code, so beside one the field is all there is to read.
  const text = file !== undefined && /\.jsonc?$/.test(file) ? yield* readText(file) : ''
  // knip takes comments and trailing commas in either kind of file, and merges the two like this.
  const config: Readonly<Record<string, unknown>> = Object.assign(
    {},
    manifest.knip,
    parseJsonc(text, undefined, { allowTrailingComma: true }),
  )

  return config
})

/** The text of `file`, or none when it is missing or cannot be read. */
function readText(file: string) {
  return FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(
    Effect.orElseSucceed(() => ''),
  )
}

/** The glob of the package.json of the packages `glob` lists, as knip writes it, `!` and all. */
function manifestGlob(glob: string): string {
  // knip drops the first `./` wherever it is.
  const listed = glob.replace('./', '')
  const negation = listed.startsWith('!') ? '!' : ''

  return `${negation}${posix.join(listed.slice(negation.length), 'package.json')}`
}

/**
 * Whether `target` matches one of `globs` and none of the `!` ones, as picomatch matches it for
 * knip, which takes a glob equal to the path as matching too.
 */
function matches(globs: ReadonlyArray<string>, target: string): boolean {
  const matchesGlob = (glob: string) =>
    glob === target ||
    new Minimatch(glob, { nocomment: true, nonegate: true, platform: 'linux' }).match(target)

  return (
    globs.some((glob) => !glob.startsWith('!') && matchesGlob(glob)) &&
    !globs.some((glob) => glob.startsWith('!') && matchesGlob(glob.slice(1)))
  )
}

const PACKAGES_KEY = /^["']?packages["']?[ \t]*:/m

/** Blanks, line breaks and comments, which a `#` starts after a blank. */
const BLANKS = /(?:\s|#[^\n]*)*/y

const INDENT = /[ \t]*/y

const ITEM = /-(?=\s|$)/y

/** Single quotes escape a quote by doubling it, double quotes escape with `\`. */
const QUOTED = /'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"/y

/** A plain scalar ends before a comment or the end of its line. */
const PLAIN = /[^\r\n]*?(?=[ \t]*(?:[ \t]#|[\r\n]|$))/y

/** Inside brackets, a `,` or `]` ends it too. */
const PLAIN_IN_BRACKETS = /[^\r\n,\]]*?(?=[ \t]*(?:[ \t]#|[\r\n,\]]|$))/y

/**
 * The globs under `packages` in a pnpm-workspace.yaml: a YAML sequence of plain or quoted strings,
 * one `- glob` per line as pnpm documents it, or `[a, b]`. `undefined` without the key or its items,
 * where knip turns to the workspaces of package.json.
 */
function pnpmPackages(yaml: string): ReadonlyArray<string> | undefined {
  const key = PACKAGES_KEY.exec(yaml)

  if (key === null) {
    return undefined
  }

  let at = key.index + key[0].length
  const read = (pattern: RegExp) => {
    pattern.lastIndex = at
    const match = pattern.exec(yaml)
    at = match === null ? at : pattern.lastIndex
    return match
  }
  const scalar = (plain: RegExp) => {
    const quoted = read(QUOTED)

    return quoted === null
      ? read(plain)![0]
      : (quoted[1]?.replaceAll("''", "'") ?? quoted[2]!.replace(/\\(.)/g, '$1'))
  }
  const globs: string[] = []

  read(BLANKS)

  if (yaml[at] === '[') {
    do {
      at += 1
      read(BLANKS)

      if (yaml[at] === ']') {
        break
      }

      globs.push(scalar(PLAIN_IN_BRACKETS))
      read(BLANKS)
    } while (yaml[at] === ',')

    return globs
  }

  while (read(ITEM) !== null) {
    read(INDENT)
    globs.push(scalar(PLAIN))
    read(BLANKS)
  }

  return globs.length > 0 ? globs : undefined
}
