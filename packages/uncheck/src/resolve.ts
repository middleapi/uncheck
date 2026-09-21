import { Effect, FileSystem, Option, Path } from 'effect'

/** An executable JS entry of an installed package, run with `process.execPath`. */
export interface Bin {
  readonly name: string
  readonly entry: string
}

interface PackageJson {
  readonly bin?: string | Readonly<Record<string, string>>
}

/** `from` and every directory above it, nearest first. */
export function ancestors(path: Path.Path, from: string): string[] {
  const dirs = [path.resolve(from)]

  for (let parent = path.dirname(dirs[0]!); parent !== dirs[dirs.length - 1]; parent = path.dirname(parent)) {
    dirs.push(parent)
  }

  return dirs
}

/** Reads and parses a JSON file, `undefined` when it is missing or malformed. */
export function readJson<A>(file: string): Effect.Effect<A | undefined, never, FileSystem.FileSystem> {
  return Effect.flatMap(FileSystem.FileSystem, fs =>
    fs.readFileString(file).pipe(
      Effect.map(text => JSON.parse(text) as A),
      Effect.orElseSucceed(() => undefined),
    ),
  )
}

/**
 * Locates the `binName` executable of `pkg` the way Node resolves packages from `cwd`: the nearest
 * `node_modules/<pkg>`. Reading its manifest directly (instead of `require.resolve`) keeps this
 * independent from the package's `exports` map.
 */
export function resolveBin(
  pkg: string,
  cwd: string,
  binName: string = pkg,
): Effect.Effect<Option.Option<Bin>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path

    for (const dir of ancestors(path, cwd)) {
      const pkgDir = path.join(dir, 'node_modules', pkg)
      const manifest = yield* readJson<PackageJson>(path.join(pkgDir, 'package.json'))

      if (manifest === undefined) {
        continue
      }

      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]

      return Option.fromNullishOr(bin).pipe(
        Option.map(entry => ({ name: binName, entry: path.resolve(pkgDir, entry) })),
      )
    }

    return Option.none()
  })
}
