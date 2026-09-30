import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { Project } from '../_shared/project'

/** What `uncheck prepare` puts at the top of a hook it creates. */
export const HEADER =
  '#!/bin/sh\n# Written by `uncheck prepare`, run it again to change the command.\n'

export const HOOK = '.git/hooks/pre-commit'

/** The hook as `prepare` names it when run from `cwd`: relative below it, absolute above it. */
export function shownFrom(project: Project, cwd: string, hook = HOOK): string {
  return cwd === '' || cwd === '.' ? hook : project.path(hook)
}

export interface CommitResult {
  readonly status: number | null
  readonly output: string
}

/** `git commit`, which runs the pre-commit hook for real. */
export function commit(
  project: Project,
  message: string,
  env: Record<string, string> = {},
  args: ReadonlyArray<string> = [],
): CommitResult {
  const { status, stdout, stderr } = spawnSync(
    'git',
    ['commit', '--quiet', `--message=${message}`, ...args],
    { cwd: project.root, env: { ...project.env, ...env }, encoding: 'utf8' },
  )

  return { status, output: `${stdout}${stderr}` }
}

/**
 * A folder of fake executables put first on PATH: `npx` (the runner the fixtures' hooks use) logs
 * the folder it runs in and its arguments, and fails when a `fail` file is in that folder.
 */
export function fakeRunner(project: Project, name = 'npx', extra = '') {
  const bin = project.path('node_modules/.fake-bin')
  const log = join(bin, 'log')

  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\necho "$(pwd -P) $*" >> "${log}"\n${extra}test ! -e fail\n`,
  )
  chmodSync(join(bin, name), 0o755)
  writeFileSync(log, '')

  return {
    bin,
    env: { PATH: `${bin}${delimiter}${project.env.PATH ?? ''}` },
    /** The lines logged since the last call. */
    ran: () => {
      const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)

      writeFileSync(log, '')

      return lines
    },
  }
}

/** Runs the hook script with `sh` the way git does, from the top of the working tree. */
export function runHook(project: Project, env: Record<string, string>, hook = HOOK) {
  return spawnSync('sh', [hook], { cwd: project.root, env: { ...project.env, ...env } }).status
}
