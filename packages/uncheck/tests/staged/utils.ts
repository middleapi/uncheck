import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'

import { CLI, environment, report } from '../utils/project'
import type { Env, Project, Run } from '../utils/project'

/** The folder of a layout's package, relative to the top of the repository. */
export function folderOf(app: string): string {
  return app.replace(/\/$/, '') || '.'
}

export const LEFTOVER_ERROR =
  'An earlier run left the unstaged versions of your files in <project>/.git/uncheck-unstaged, at their paths from the top of the repository. Unless another commit is running, copy back what your files are missing, delete the folder, then commit again.'

export const EMPTY_COMMIT_ERROR =
  'The fixes undid every staged change and are staged now, so nothing new is left to commit. Commit again: git amends only the message, or refuses an empty commit. To allow empty commits, pass --allow-empty to `uncheck staged`, or to `uncheck prepare` for the hook it writes.'

export function conflictError(files: string): string {
  return `The fixes conflict with the unstaged changes of ${files} and were undone. Stage the whole file, or stash its unstaged changes, then commit again.`
}

export function strandedError(files: string): string {
  return `The unstaged changes of ${files} could not be put back, see above.`
}

/** The line explaining why the unstaged changes of `files` stayed in the saved folder. */
export function stranded(files: string, reason: string): string {
  return `✘ could not put back the unstaged changes of ${files}: ${reason}`
}

export const STRANDED_HINT =
  '  their unstaged versions are in <project>/.git/uncheck-unstaged, at their paths from the top of the repository: copy back what your files are missing and delete the folder\n'

const MIDDLE = 'export const b = 1;\nexport const c = 1;\nexport const d = 1;\n'

/**
 * The versions of a file whose staged change to its first line needs formatting, while an unstaged
 * change edits its last line, far enough apart to merge.
 */
export const VERSIONS = {
  committed: `export const a = 1;\n${MIDDLE}export const e = 1;\n`,
  staged: `export const   a = 2\n${MIDDLE}export const e = 1;\n`,
  unstaged: `export const   a = 2\n${MIDDLE}export const e = 2;\n`,
  fixed: `export const a = 2;\n${MIDDLE}export const e = 1;\n`,
  merged: `export const a = 2;\n${MIDDLE}export const e = 2;\n`,
}

/** Stages the `staged` version of `file`, then leaves its `unstaged` version in the working tree. */
export function stagePartially(project: Project, file: string): Project {
  return project.stage({ [file]: VERSIONS.staged }).write({ [file]: VERSIONS.unstaged })
}

export function expectRestored(project: Project, file: string): void {
  expect(project.read(file)).toBe(VERSIONS.unstaged)
  expect(inIndex(project, file)).toBe(VERSIONS.staged)
  expect(project.exists('.git/uncheck-unstaged')).toBe(false)
}

export const SAVED_LINE = '// saved while tsc ran\n'

export function saveWhileTscRuns(
  project: Project,
  files: ReadonlyArray<string>,
  { atEnd = false }: { readonly atEnd?: boolean } = {},
): Project {
  const paths = JSON.stringify(files.map((file) => project.path(file)))
  const line = JSON.stringify(SAVED_LINE)
  const content = "fs.readFileSync(file, 'utf8')"

  return project.fake(
    'typescript',
    `const fs = require('node:fs')\nfor (const file of ${paths}) fs.writeFileSync(file, ${atEnd ? `${content} + ${line}` : `${line} + ${content}`})\n`,
  )
}

export function inIndex(project: Project, file: string): string {
  return project.git('show', `:${file}`)
}

export function expectFixesStaged(output: string, files: string, checks: string): void {
  expect(report(output).slice(-2)).toEqual([
    `✔ staged the fixes to ${files}`,
    `✔ all checks passed (${checks})`,
  ])
}

export interface Started {
  readonly child: ChildProcessWithoutNullStreams
  /** Resolves once stdout or stderr has shown `marker`. */
  readonly printed: (marker: string) => Promise<void>
  readonly exited: Promise<Run>
}

interface StartOptions {
  readonly cwd: string
  readonly env?: Env
  readonly ownProcessGroup?: boolean
}

function start(
  command: ReadonlyArray<string>,
  { cwd, env, ownProcessGroup = false }: StartOptions,
): Started {
  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env: environment(env),
    detached: ownProcessGroup,
  })
  const waiters: Array<{ readonly marker: string; readonly resolve: () => void }> = []
  const output = { stdout: '', stderr: '' }
  const shown = (marker: string) => output.stdout.includes(marker) || output.stderr.includes(marker)
  const collect = (stream: keyof typeof output) => (chunk: string) => {
    output[stream] += chunk

    for (const waiter of waiters.filter(({ marker }) => shown(marker))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  onTestFinished(() => {
    if (!ownProcessGroup) {
      child.kill('SIGKILL')
      return
    }

    // Throws once every process of the group has exited.
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {}
  })

  child.stdout.setEncoding('utf8').on('data', collect('stdout'))
  child.stderr.setEncoding('utf8').on('data', collect('stderr'))

  return {
    child,
    printed: (marker) =>
      new Promise((resolve) => {
        if (shown(marker)) {
          resolve()
        } else {
          waiters.push({ marker, resolve })
        }
      }),
    exited: new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal, ...output }))
    }),
  }
}

/** Starts the CLI without waiting for it, for tests that act on the process while it runs. */
export function startUncheck(
  project: Project,
  args: ReadonlyArray<string>,
  { cwd = '.', env }: { readonly cwd?: string; readonly env?: Env } = {},
): Started {
  return start([...CLI, ...args], { cwd: project.path(cwd), env })
}

/**
 * Starts `git <args>` in a process group of its own, which `interrupt` sends Ctrl-C to as a terminal
 * would. `exited` waits for the hooks git started too, since they hold its output.
 */
export function startGit(
  project: Project,
  args: ReadonlyArray<string>,
): Started & { readonly interrupt: () => void } {
  const started = start(['git', ...args], { cwd: project.dir, ownProcessGroup: true })

  return { ...started, interrupt: () => process.kill(-started.child.pid!, 'SIGINT') }
}
