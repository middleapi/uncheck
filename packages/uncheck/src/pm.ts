import { Effect, FileSystem, Option, Path } from 'effect'

import { ancestors, readJson } from './files'

// Hooks never get a terminal to ask in, so plain `npx` and `bunx` would download and run the latest
// release whenever the project has none, and Yarn 1 wraps a run in lines of its own on stdout, where
// agents expect nothing but their JSON.
const EXEC_BY_PACKAGE_MANAGER: Readonly<Record<string, string>> = {
  pnpm: 'pnpm exec',
  yarn: 'yarn run --silent',
  bun: 'bunx --no-install',
  npm: 'npx --no',
}

const EXEC_BY_LOCKFILE: ReadonlyArray<readonly [lockfile: string, exec: string]> = [
  ['pnpm-lock.yaml', 'pnpm exec'],
  ['yarn.lock', 'yarn run --silent'],
  ['bun.lock', 'bunx --no-install'],
  ['bun.lockb', 'bunx --no-install'],
  ['package-lock.json', 'npx --no'],
]

/** Every prefix `detectExec` returns or once returned, so a generated command line can be recognised again. */
const EXECS: ReadonlyArray<string> = [
  ...new Set([
    ...Object.values(EXEC_BY_PACKAGE_MANAGER),
    ...EXEC_BY_LOCKFILE.map(([, exec]) => exec),
    'yarn',
    'bunx',
    'npx',
  ]),
]

const FLAGS = /^(?: --[\w=./@+-]+)*$/

/** Whether `text` runs `command`, directly or through a package manager, with nothing but flags after it. */
export function invokes(text: string, command: string): boolean {
  return ['', ...EXECS.map((exec) => `${exec} `)].some((prefix) => {
    const rest = text.startsWith(prefix) ? text.slice(prefix.length) : ''

    return (
      (rest === command || rest.startsWith(`${command} `)) && FLAGS.test(rest.slice(command.length))
    )
  })
}

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

    if (declared !== undefined) {
      return declared
    }

    const lockfile = yield* Effect.findFirst(EXEC_BY_LOCKFILE, ([file]) =>
      fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
    )

    if (Option.isSome(lockfile)) {
      return lockfile.value[1]
    }
  }

  return 'npx --no'
})
