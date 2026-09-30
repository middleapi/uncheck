import { execFileSync } from 'node:child_process'
import { chmodSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { Env, Project, Run, RunOptions } from '../utils/project'
import { environment, temporaryDirectory } from '../utils/project'

export const HEADER =
  '#!/bin/sh\n# Written by `uncheck prepare`, run it again to change the command.\n'

export const COMMAND = 'pnpm exec uncheck staged --fix'

export function prepare(
  project: Project,
  args: ReadonlyArray<string> = [],
  options?: RunOptions,
): Promise<Run> {
  return project.uncheck(['prepare', '--pre-commit', ...args], options)
}

export function hookLine(app: string, command = COMMAND): string {
  return app === '' ? `${command} || exit 1` : `(cd "${app.slice(0, -1)}" && ${command}) || exit 1`
}

export function shownHook(project: Project, app: string, hook = '.git/hooks/pre-commit'): string {
  return app === '' ? hook : project.path(hook)
}

export function written(
  shown: string,
  result: 'created' | 'updated' | 'unchanged',
  command = COMMAND,
): string {
  return `✔ pre-commit ${shown} ${result}\n\nThe hook runs ${command} before every commit, \`git commit --no-verify\` skips it.\n`
}

export function notWritten(shown: string, reason: string): string {
  return `✘ pre-commit ${shown} not written, ${reason}\n`
}

export function mode(project: Project, file: string): number {
  return statSync(project.path(file)).mode & 0o7777
}

export function chmod(project: Project, file: string, value: number): void {
  chmodSync(project.path(file), value)
}

export function gitConfig(content: string): string {
  const file = join(temporaryDirectory(), 'gitconfig')

  writeFileSync(file, content)

  return file
}

export function withGitWithoutShowScope(env: Env = {}): Env {
  const real = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
    env: environment(),
  }).trim()
  const bin = temporaryDirectory()

  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      `case " $* " in *" --show-scope "*) echo "error: unknown option 'show-scope'" >&2; exit 129;; esac`,
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  return { ...env, PATH: `${bin}${delimiter}${environment().PATH}` }
}

export const DISPATCHER = [
  's="$(dirname "$(dirname "$0")")/$(basename "$0")"',
  '[ ! -f "$s" ] && exit 0',
  'export PATH="node_modules/.bin:$PATH"',
  'sh -e "$s" "$@"',
  'exit $?',
  '',
].join('\n')

export const HUSKY_SHIM = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'

export function installHusky(project: Project, hook: string): Project {
  project.write({
    '.husky/_/h': DISPATCHER,
    '.husky/_/pre-commit': HUSKY_SHIM,
    '.husky/pre-commit': hook,
  })
  chmod(project, '.husky/_/pre-commit', 0o755)
  chmod(project, '.husky/pre-commit', 0o644)
  project.git('config', 'core.hooksPath', '.husky/_')

  return project
}
