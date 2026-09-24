import { Effect, FileSystem, Option, Path } from 'effect'

import { ancestors, readJson } from './files'

// Hooks never get a terminal to ask in, so plain `npx` and `bunx` would download and run the latest
// release whenever the project has none, and Yarn 1 wraps a run in lines of its own on stdout, where
// agents expect nothing but their JSON.
const EXEC_BY_PACKAGE_MANAGER: ReadonlyMap<string, string> = new Map([
  ['pnpm', 'pnpm exec'],
  ['yarn', 'yarn run --silent'],
  ['bun', 'bunx --no-install'],
  ['npm', 'npx --no'],
])

/** Yarn 2+ runs only the binaries of the workspace it is started in, unless told to use the root's. */
export const YARN_TOP_LEVEL = 'yarn run -T --silent'

const PACKAGE_MANAGER_BY_LOCKFILE = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const

/** Every prefix uncheck writes or once wrote, so a generated command line can be recognised again. */
const EXECS: ReadonlyArray<string> = [
  ...EXEC_BY_PACKAGE_MANAGER.values(),
  YARN_TOP_LEVEL,
  'yarn',
  'bunx',
  'npx',
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
        ? EXEC_BY_PACKAGE_MANAGER.get(manifest.packageManager.split('@')[0]!)
        : undefined

    if (declared !== undefined) {
      return declared
    }

    const lockfile = yield* Effect.findFirst(PACKAGE_MANAGER_BY_LOCKFILE, ([file]) =>
      fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
    )

    if (Option.isSome(lockfile)) {
      return EXEC_BY_PACKAGE_MANAGER.get(lockfile.value[1])!
    }
  }

  return EXEC_BY_PACKAGE_MANAGER.get('npm')!
})
