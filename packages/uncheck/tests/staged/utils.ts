import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { CLI, environment } from '../utils/project'
import type { Env, Files, Project, Run } from '../utils/project'

/** The folder of a layout's package, relative to the top of the repository. */
export function folderOf(app: string): string {
  return app.replace(/\/$/, '') || '.'
}

export const UTILS_NOT_FOUND =
  "src/index.ts(1,24): error TS2307: Cannot find module './utils' or its corresponding type declarations."

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

/** What `saveWhileTscRuns` adds to the top of a file. */
export const SAVED_LINE = '// saved while tsc ran\n'

/** Fakes a tsc that adds `SAVED_LINE` to `files` as it runs, as an editor saving them would. */
export function saveWhileTscRuns(project: Project, files: ReadonlyArray<string>): Project {
  const paths = JSON.stringify(files.map((file) => project.path(file)))

  return project.fake(
    'typescript',
    `const fs = require('node:fs')\nfor (const file of ${paths}) fs.writeFileSync(file, ${JSON.stringify(SAVED_LINE)} + fs.readFileSync(file, 'utf8'))\n`,
  )
}

/** Commits `files` on a new `side` branch, then goes back to `main`. */
export function commitOnSide(project: Project, files: Files): Project {
  project.git('checkout', '--quiet', '-b', 'side')
  project.write(files).commit('side')
  project.git('checkout', '--quiet', 'main')

  return project
}

export function inIndex(project: Project, file: string): string {
  return project.git('show', `:${file}`)
}

export interface Started {
  readonly child: ChildProcessWithoutNullStreams
  /** Resolves once stdout has shown `marker`. */
  readonly printed: (marker: string) => Promise<void>
  readonly exited: Promise<Run>
}

/** Starts the CLI without waiting for it, for tests that act on the process while it runs. */
export function startUncheck(
  project: Project,
  args: ReadonlyArray<string>,
  { cwd = '.', env }: { readonly cwd?: string; readonly env?: Env } = {},
): Started {
  const child = spawn(CLI[0], [...CLI.slice(1), ...args], {
    cwd: project.path(cwd),
    env: environment(env),
  })
  const waiters: Array<{ readonly marker: string; readonly resolve: () => void }> = []
  let stdout = ''
  let stderr = ''

  onTestFinished(() => {
    child.kill('SIGKILL')
  })

  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk

    for (const waiter of waiters.filter(({ marker }) => stdout.includes(marker))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })

  return {
    child,
    printed: (marker) =>
      new Promise((resolve) => {
        if (stdout.includes(marker)) {
          resolve()
        } else {
          waiters.push({ marker, resolve })
        }
      }),
    exited: new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }))
    }),
  }
}
