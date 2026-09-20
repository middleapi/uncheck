import { Effect, FileSystem, Option, Path } from 'effect'

export interface Tool {
  readonly name: string
  /** Absolute path to the JS entry to execute with `process.execPath`. */
  readonly bin: string
}

interface PackageJson {
  readonly bin?: string | Readonly<Record<string, string>>
}

/**
 * Locates `pkg` the way Node resolves packages from `cwd`: walk up looking for
 * `node_modules/<pkg>/package.json`. Reading the manifest directly (instead of
 * `require.resolve`) keeps this independent from the package's `exports` map.
 */
export function resolveTool(
  pkg: string,
  cwd: string,
  binName: string = pkg,
): Effect.Effect<Option.Option<Tool>, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    let dir = path.resolve(cwd)

    while (true) {
      const pkgDir = path.join(dir, 'node_modules', pkg)

      const manifest = yield* fs.readFileString(path.join(pkgDir, 'package.json')).pipe(
        Effect.map(text => JSON.parse(text) as PackageJson),
        Effect.orElseSucceed(() => undefined),
      )

      if (manifest !== undefined) {
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]

        return Option.fromNullishOr(bin).pipe(
          Option.map(entry => ({ name: binName, bin: path.resolve(pkgDir, entry) })),
        )
      }

      const parent = path.dirname(dir)

      if (parent === dir) {
        return Option.none()
      }

      dir = parent
    }
  })
}
