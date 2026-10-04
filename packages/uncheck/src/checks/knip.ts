import { posix } from 'node:path'

import { Effect, FileSystem, Path, Predicate } from 'effect'
import { Minimatch } from 'minimatch'

import { NothingToCheck } from '../errors.ts'
import { foldersAboveInRepository, readJson, slashedRelative } from '../files.ts'
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

    // knip reads package.json only in the folder it runs in, and fails without one.
    if ((yield* readJson(path.join(cwd, 'package.json'))) === undefined) {
      return yield* Effect.fail(new NothingToCheck({ reason: 'no package.json found' }))
    }

    const root = yield* enclosingWorkspace(cwd)

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

/**
 * The nearest workspace root above `cwd` in its repository, when that root lists `cwd` among its
 * packages, unless `cwd` is a workspace root itself.
 */
const enclosingWorkspace = Effect.fn(function* (cwd: string) {
  const path = yield* Path.Path

  if ((yield* workspacePatterns(cwd)) !== undefined) {
    return undefined
  }

  for (const dir of yield* foldersAboveInRepository(cwd)) {
    const patterns = yield* workspacePatterns(dir)

    if (patterns !== undefined) {
      return isPackageOf(patterns, slashedRelative(path, dir, cwd)) ? dir : undefined
    }
  }

  return undefined
})

/** The package globs of a workspace root, from pnpm-workspace.yaml before package.json as knip reads them. */
const workspacePatterns = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const manifest = yield* readJson(path.join(dir, 'package.json'))

  // knip only runs where a package.json is.
  if (manifest === undefined) {
    return undefined
  }

  const yaml = yield* fs
    .readFileString(path.join(dir, 'pnpm-workspace.yaml'))
    .pipe(Effect.orElseSucceed(() => ''))
  const { workspaces } = manifest
  const listed =
    pnpmPackages(yaml) ??
    (Array.isArray(workspaces)
      ? workspaces
      : Predicate.hasProperty(workspaces, 'packages') && Array.isArray(workspaces.packages)
        ? workspaces.packages
        : [])
  const patterns: ReadonlyArray<string> = listed.filter(Predicate.isString)

  return patterns.length > 0 ? patterns : undefined
})

/** Whether `folder` holds a package `patterns` list, matching its package.json as knip does. */
function isPackageOf(patterns: ReadonlyArray<string>, folder: string): boolean {
  const manifest = `${folder}/package.json`
  const matches = (pattern: string) =>
    new Minimatch(posix.join(pattern, 'package.json'), {
      nocomment: true,
      nonegate: true,
      platform: 'linux',
    }).match(manifest)

  return (
    patterns.some((pattern) => !pattern.startsWith('!') && matches(pattern)) &&
    !patterns.some((pattern) => pattern.startsWith('!') && matches(pattern.slice(1)))
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
