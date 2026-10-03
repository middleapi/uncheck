import process from 'node:process'

import { Effect, FileSystem, Option, Path } from 'effect'

import { ancestors, fileKind, readJson } from './files.ts'

// Hooks never get a terminal to ask in, so plain `npx` and `bunx` would download and run the latest
// release whenever the project has none, and Yarn 1 wraps a run in lines of its own on stdout, where
// agents expect nothing but their JSON.
const EXEC_BY_PACKAGE_MANAGER = {
  pnpm: 'pnpm exec',
  yarn: 'yarn run --silent',
  bun: 'bunx --no-install',
  npm: 'npx --no',
}

const YARN_TOP_LEVEL = 'yarn run -T --silent'

const PACKAGE_MANAGER_BY_LOCKFILE = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const

/** Every prefix uncheck writes or once wrote, so a generated command line can be recognised again. */
const EXECS: ReadonlyArray<string> = [
  ...Object.values(EXEC_BY_PACKAGE_MANAGER),
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

type PackageManagerName = keyof typeof EXEC_BY_PACKAGE_MANAGER

export interface PackageManager {
  readonly name: PackageManagerName
  readonly yarnBerry: boolean
}

function isPackageManagerName(name: string): name is PackageManagerName {
  return Object.hasOwn(EXEC_BY_PACKAGE_MANAGER, name)
}

function isYarnBerry(name: string, version: string | undefined): boolean {
  return name === 'yarn' && version !== undefined && !version.startsWith('1.')
}

/**
 * The package manager the nearest project declares in `packageManager` or, failing that, its
 * lockfile, or else the one that started uncheck, which `npx`, `pnpm dlx`, `yarn dlx` and `bunx` say
 * in `npm_config_user_agent`.
 */
export const detectPackageManager = Effect.fn(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  for (const dir of ancestors(path, cwd)) {
    const manifest = yield* readJson(path.join(dir, 'package.json'))
    const [name = '', version] =
      typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@') : []

    if (isPackageManagerName(name)) {
      return { name, yarnBerry: isYarnBerry(name, version) } satisfies PackageManager
    }

    const lockfile = yield* Effect.findFirst(PACKAGE_MANAGER_BY_LOCKFILE, ([file]) =>
      fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
    )

    if (Option.isSome(lockfile)) {
      const [, found] = lockfile.value

      // A Yarn 2+ project that declares no version still has its settings, such as `yarnPath`, here.
      return {
        name: found,
        yarnBerry:
          found === 'yarn' && (yield* fileKind(path.join(dir, '.yarnrc.yml'))) !== undefined,
      } satisfies PackageManager
    }
  }

  const [, name = '', version] =
    /^([\w-]+)\/(\S+)/.exec(process.env.npm_config_user_agent ?? '') ?? []

  return isPackageManagerName(name)
    ? ({ name, yarnBerry: isYarnBerry(name, version) } satisfies PackageManager)
    : ({ name: 'npm', yarnBerry: false } satisfies PackageManager)
})

/** The `npx`-like prefix that runs a project binary, from the package manager of `cwd`. */
export const detectExec = Effect.fn(function* (cwd: string, { fromAnyWorkspace = false } = {}) {
  const { name, yarnBerry } = yield* detectPackageManager(cwd)

  // Yarn 2+ runs only the binaries of the workspace it is started in, unless told to use the root's.
  return fromAnyWorkspace && yarnBerry ? YARN_TOP_LEVEL : EXEC_BY_PACKAGE_MANAGER[name]
})
