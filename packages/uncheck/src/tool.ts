import { createRequire } from 'node:module'
import process from 'node:process'

import { Console, Effect, Path, Predicate, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { ancestors, readJson } from './files.ts'
import { colors } from './style.ts'
import type { CheckCommand } from './types.ts'

export interface Bin {
  readonly name: string
  readonly entry: string
}

/**
 * Locates the `binName` executable of `pkg` the way Node resolves packages from `cwd`: the nearest
 * `node_modules/<pkg>`, whose manifest is read directly so its `exports` map does not matter, and,
 * under Yarn PnP, first wherever its resolver finds `<pkg>/package.json`.
 */
export const resolveBin = Effect.fn(function* (pkg: string, cwd: string, binName: string = pkg) {
  const path = yield* Path.Path

  for (const dir of ancestors(path, cwd)) {
    // Yarn PnP installs have no node_modules, only the resolver it loads into processes it starts.
    const resolved =
      process.versions.pnp === undefined
        ? undefined
        : yield* Effect.try(() =>
            createRequire(path.join(dir, 'package.json')).resolve(`${pkg}/package.json`),
          ).pipe(Effect.orElseSucceed(() => undefined))
    const manifestPath = resolved ?? path.join(dir, 'node_modules', pkg, 'package.json')
    const manifest = yield* readJson(manifestPath)

    if (manifest === undefined) {
      continue
    }

    const bin =
      typeof manifest.bin === 'string'
        ? manifest.bin
        : Predicate.isObject(manifest.bin)
          ? manifest.bin[binName]
          : undefined

    return typeof bin === 'string'
      ? { name: binName, entry: path.resolve(path.dirname(manifestPath), bin) }
      : undefined
  }

  return undefined
})

/** Windows caps a whole command line, node and the tool path included, at 32,767 characters. */
const MAX_ARGV_LENGTH = 30_000

/**
 * No arguments make no batch: a tool or git command run without paths acts on every file. `prefix`
 * is what each argument gets in front of it, as `CheckCommand.filePrefix`.
 */
export function argvBatches(
  args: ReadonlyArray<string>,
  prefix = '',
): ReadonlyArray<ReadonlyArray<string>> {
  const batches: string[][] = []
  let length = 0

  for (const arg of args) {
    // Room for the separator and the quotes around an argument with a space.
    const room = prefix.length + arg.length + 3

    if (batches.length === 0 || length + room > MAX_ARGV_LENGTH) {
      batches.push([])
      length = 0
    }

    batches[batches.length - 1]!.push(arg)
    length += room
  }

  return batches
}

/** Tools read a leading `-` as a flag, and oxfmt reads a leading `!` as an exclusion even after `--`. */
function asFileArgument(file: string): string {
  return file.startsWith('-') || file.startsWith('!') ? `./${file}` : file
}

/** Output goes through `Console` so it stays in order with uncheck's own lines and can be captured. */
export const execute = Effect.fn(function* (
  { bin, args, files = [], filePrefix }: CheckCommand,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fileArgs = files.map((file) =>
    filePrefix === undefined ? asFileArgument(file) : `${filePrefix}${file}`,
  )

  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [bin.entry, ...args, ...fileArgs], {
      cwd,
      stdin: 'ignore',
      // A piped tool cannot see the terminal, so tell it when colors are wanted. Node tools read
      // FORCE_COLOR, and Rust ones like sherif and fallow CLICOLOR_FORCE.
      env: colors ? { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' } : {},
      extendEnv: true,
    }),
  )

  yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.all)), (text) =>
    Console.log(text),
  )

  return yield* handle.exitCode
}, Effect.scoped)

export function logLines(lines: ReadonlyArray<string>): Effect.Effect<void> {
  return Effect.forEach(lines, (line) => Console.log(line), { discard: true })
}

export function captureLines<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [A, ReadonlyArray<string>], E, R> {
  return Effect.suspend(() => {
    const lines: string[] = []
    const capture: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...parts: ReadonlyArray<unknown>) => {
        lines.push(parts.join(' '))
      },
    })

    return effect.pipe(
      Effect.map((result) => [result, lines] as const),
      Effect.provideService(Console.Console, capture),
    )
  })
}
