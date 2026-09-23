import { Effect, FileSystem, Option, Path } from 'effect'

import { ancestors, readJson } from './files'

const EXEC_BY_PACKAGE_MANAGER: Readonly<Record<string, string>> = {
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  bun: 'bunx',
  npm: 'npx',
}

const EXEC_BY_LOCKFILE: ReadonlyArray<readonly [lockfile: string, exec: string]> = [
  ['pnpm-lock.yaml', 'pnpm exec'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bunx'],
  ['bun.lockb', 'bunx'],
  ['package-lock.json', 'npx'],
]

/** Every prefix `detectExec` can return, so a generated command line can be recognised again. */
export const EXECS: ReadonlyArray<string> = [
  ...new Set([
    ...Object.values(EXEC_BY_PACKAGE_MANAGER),
    ...EXEC_BY_LOCKFILE.map(([, exec]) => exec),
  ]),
]

/**
 * The `npx`-like prefix that runs a project binary, from the package manager the nearest project
 * declares in `packageManager` or, failing that, its lockfile.
 */
export const detectExec = Effect.fn(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  for (const dir of ancestors(path, cwd)) {
    const manifest = yield* readJson(path.join(dir, 'package.json'))
    const declared =
      typeof manifest?.packageManager === 'string'
        ? EXEC_BY_PACKAGE_MANAGER[manifest.packageManager.split('@')[0] ?? '']
        : undefined

    const lockfile = yield* Effect.findFirst(EXEC_BY_LOCKFILE, ([file]) =>
      fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
    )

    if (declared !== undefined || Option.isSome(lockfile)) {
      return declared ?? Option.getOrThrow(lockfile)[1]
    }
  }

  return 'npx'
})
