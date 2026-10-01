import type { Project, Run, RunOptions } from '../utils/project'

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
  const folder = app.slice(0, -1)

  return app === ''
    ? `${command} || exit 1`
    : `git --literal-pathspecs diff --cached --quiet -- "${folder}" || [ ! -d "${folder}" ] || (cd "${folder}" && ${command}) || exit 1`
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

export const DISPATCHER = [
  's="$(dirname "$(dirname "$0")")/$(basename "$0")"',
  '[ ! -f "$s" ] && exit 0',
  'export PATH="node_modules/.bin:$PATH"',
  'sh -e "$s" "$@"',
  'exit $?',
  '',
].join('\n')

export const HUSKY_4_RUNNER = '. "$(dirname "$0")/husky.sh"'

export const HUSKY_4_BANNER = [
  '#!/bin/sh',
  '# husky',
  '',
  '# Created by Husky v4.3.8 (https://github.com/typicode/husky#readme)',
  '#   At: 1/20/2021, 3:58:58 PM',
  '#   From: /home/me/my-app (https://github.com/me/my-app#readme)',
  '',
  '',
].join('\n')

export const HUSKY_SHIM = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'

export function installHusky(project: Project, hook: string): Project {
  project
    .write({
      '.husky/_/h': DISPATCHER,
      '.husky/_/pre-commit': HUSKY_SHIM,
      '.husky/pre-commit': hook,
    })
    .chmod('.husky/_/pre-commit', 0o755)
    .chmod('.husky/pre-commit', 0o644)
    .git('config', 'core.hooksPath', '.husky/_')

  return project
}
