import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { CLI, environment, Project, temporaryDirectory } from '../utils/project'
import type { Env, Files, Run } from '../utils/project'

/** The folder of a layout's package, relative to the top of the repository. */
export function folderOf(app: string): string {
  return app.replace(/\/$/, '') || '.'
}

// git translates its messages to the locale of the machine, so tests asserting them need this.
export const UNTRANSLATED: Env = { LC_ALL: 'C' }

/** An environment whose `git` first runs the shell `script`, which finds the real git in `$GIT`. */
export function wrappedGit(script: string): Env {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const shims = temporaryDirectory()

  writeFileSync(join(shims, 'git'), `#!/bin/sh\nGIT='${real}'\n${script}\nexec "$GIT" "$@"\n`, {
    mode: 0o755,
  })

  return { PATH: `${shims}${delimiter}${environment().PATH}` }
}

export const LEFTOVER_ERROR =
  'An earlier run left the unstaged versions of your files in <project>/.git/uncheck-unstaged, at their paths from the top of the repository. Unless another commit is running, copy back what your files are missing, delete the folder, then commit again.'

export const EMPTY_COMMIT_ERROR =
  'The fixes undid every staged change, so the commit would be empty. To allow empty commits, pass --allow-empty to `uncheck staged`, or to `uncheck prepare` for the hook it writes.'

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

/** How tsc checks the package of each layout. */
export const TSC_COMMAND: Readonly<Record<string, string>> = {
  'single repo': '▶ tsc -p tsconfig.json --noEmit',
  'monorepo': '▶ tsc -b tsconfig.json',
}

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
  stage(project, { [file]: VERSIONS.staged })

  return project.write({ [file]: VERSIONS.unstaged })
}

/** Writes `files` and stages them as they are. */
export function stage(project: Project, files: Files): Project {
  project.write(files)
  project.git('--literal-pathspecs', 'add', '--all', '--', ...Object.keys(files))

  return project
}

/** Commits `files` on a new `side` branch, then goes back to `main`. */
export function commitOnSide(project: Project, files: Files): Project {
  project.git('checkout', '--quiet', '-b', 'side')
  project.write(files).commit('side')
  project.git('checkout', '--quiet', 'main')

  return project
}

/** A checkout of `project` made with `git worktree add`, with the links an install would make. */
export function linkedWorktree(project: Project, app: string): Project {
  const worktree = new Project(join(temporaryDirectory(), 'linked'))

  project.git('worktree', 'add', '--quiet', worktree.dir)
  worktree.link('node_modules', project.path('node_modules'))

  if (app !== '') {
    worktree.link(`${app}node_modules/@repo/core`, '../../../core')
  }

  return worktree
}

/** Tracked changes only, since the monorepo's tsc leaves build info files behind. */
export function status(project: Project): string {
  return project.git('status', '--porcelain', '--untracked-files=no')
}

export function inIndex(project: Project, file: string): string {
  return project.git('show', `:${file}`)
}

export function mode(project: Project, file: string): number {
  return statSync(project.path(file)).mode & 0o777
}

/** How the CLI prints the error that stops a run. */
export function failure(message: string): string {
  return `\nERROR\n  ${message}\n`
}

/** `text` with the folder of `project`, which differs between runs, as `<project>`. */
export function normalized(project: Project, text: string): string {
  return text.replaceAll(project.dir, '<project>')
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
