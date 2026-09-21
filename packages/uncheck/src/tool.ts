import { Effect, Path, Predicate } from 'effect'
import { ancestors, readJson } from './files'

export interface Bin {
  readonly name: string
  readonly entry: string
}

/**
 * Locates the `binName` executable of `pkg` the way Node resolves packages from `cwd`: the nearest
 * `node_modules/<pkg>`. Reading its manifest directly (instead of `require.resolve`) keeps this
 * independent from the package's `exports` map.
 */
export const resolveBin = Effect.fn(function* (pkg: string, cwd: string, binName: string = pkg) {
  const path = yield* Path.Path

  for (const dir of ancestors(path, cwd)) {
    const pkgDir = path.join(dir, 'node_modules', pkg)
    const manifest = yield* readJson(path.join(pkgDir, 'package.json'))

    if (manifest === undefined) {
      continue
    }

    const bin =
      typeof manifest.bin === 'string'
        ? manifest.bin
        : Predicate.isObject(manifest.bin)
          ? manifest.bin[binName]
          : undefined

    return typeof bin === 'string' ? { name: binName, entry: path.resolve(pkgDir, bin) } : undefined
  }

  return undefined
})

/** Command lines stay well below every platform's argument limit. */
const MAX_ARGV_LENGTH = 65_536

export function argvBatches(args: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> {
  const batches: string[][] = [[]]
  let length = 0

  for (const arg of args) {
    if (length + arg.length + 1 > MAX_ARGV_LENGTH) {
      batches.push([])
      length = 0
    }

    batches[batches.length - 1]!.push(arg)
    length += arg.length + 1
  }

  return batches
}
