import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

import type {
  Files,
  Layout,
  Project,
  ProjectOptions,
  RunOptions,
  RunResult,
} from '../_shared/project'
import { createProject, uncheckBin } from '../_shared/project'

/**
 * Where `uncheck staged` runs: the top of the repository, or inside the package folder the way the
 * pre-commit hook of a monorepo runs it.
 */
export interface Place {
  readonly layout: Layout
  readonly at: 'top' | 'package'
}

/** A single package, and a monorepo both from its top and from inside `packages/app`. */
export const PLACES: ReadonlyArray<Place> = [
  { layout: 'single', at: 'top' },
  { layout: 'monorepo', at: 'top' },
  { layout: 'monorepo', at: 'package' },
]

export const eachPlace = describe.each(PLACES)

export interface Staged {
  readonly project: Project
  /** Where the command runs, relative to the top. */
  readonly cwd: string
  /** How uncheck names a file of the package from where it runs. */
  readonly shown: (file: string) => string
  /** Runs `uncheck staged <args>` where this place runs it. */
  readonly staged: (
    args?: ReadonlyArray<string>,
    options?: RunOptions,
  ) => ReturnType<Project['run']>
  /** The staged content of a file of the package. */
  readonly index: (file: string) => string
}

export function setup(place: Place, options: ProjectOptions = {}): Staged {
  const project = createProject(place.layout, options)

  return at(project, place.at === 'package' ? project.appDir : '')
}

/** The same helpers for a project that already exists, running in `cwd`. */
export function at(project: Project, cwd: string): Staged {
  const shown = (file: string) =>
    cwd === project.appDir ? file : project.inApp(file).slice(cwd === '' ? 0 : cwd.length + 1)

  return {
    project,
    cwd,
    shown,
    staged: (args = [], options = {}) => project.run(['staged', ...args], { cwd, ...options }),
    index: (file) => project.git('show', `:${project.inApp(file)}`),
  }
}

/** A tool package whose bin is `script`, for situations a real tool cannot produce. */
export function fakeTool(name: string, script: string): Files {
  return {
    [`node_modules/${name}/package.json`]: { name, bin: 'bin.js' },
    [`node_modules/${name}/bin.js`]: script,
  }
}

/** Commits `files` on a `side` branch and comes back. */
export function commitOnSide(project: Project, files: Files) {
  project.git('checkout', '--quiet', '-b', 'side')
  project.write(files)
  project.git('add', '-A')
  project.git('commit', '--quiet', '-m', 'side')
  project.git('checkout', '--quiet', '-')
}

/**
 * Writes a pre-commit hook that runs `uncheck <args>` in `folder`, the way a monorepo hook enters a
 * package first, into the hooks folder of the repository (`gitDir` for a linked worktree's common one).
 */
export function preCommitHook(project: Project, args: string, folder = '.') {
  const hook = project.path('.git/hooks/pre-commit')

  mkdirSync(dirname(hook), { recursive: true })
  writeFileSync(
    hook,
    `#!/bin/sh\n(cd "${folder}" && "${process.execPath}" "${uncheckBin(project)}" ${args}) || exit 1\n`,
  )
  chmodSync(hook, 0o755)
}

/** Runs git without throwing, for commands a hook may stop. */
export function gitTry(project: Project, cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd: project.path(cwd),
    env: project.env,
    encoding: 'utf8',
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Starts `uncheck <args>` in `cwd` and hands back the process, to send it signals. */
export function startUncheck(project: Project, args: ReadonlyArray<string>, cwd = '') {
  const child = spawn(process.execPath, [uncheckBin(project), ...args], {
    cwd: project.path(cwd),
    env: project.env,
    stdio: 'ignore',
  })

  onTestFinished(() => {
    child.kill('SIGKILL')
  })

  return child
}

/** Asserts the exit code, showing what the run printed when it differs. */
export function expectExit(result: RunResult, code: number) {
  expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(code)
}

/** The path from the top of a file of the package that plays the app, before a project exists. */
export function inApp(layout: Layout, file: string) {
  return layout === 'single' ? file : `packages/app/${file}`
}
