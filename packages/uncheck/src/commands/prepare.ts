import { Console, Effect, FileSystem, Option, Path } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { userError } from '../errors'
import { git } from '../git'
import { detectExec, EXECS } from '../pm'
import { bold, dim, green, red } from '../style'
import {
  cwdFlag,
  onlyFlag,
  requireFlag,
  selectionArgs,
  skipFlag,
  validateSelection,
} from './uncheck'

const HOOK_COMMAND = 'uncheck staged'
const HEADER = '#!/bin/sh\n# Written by `uncheck prepare`, run it again to change the command.\n'

/** `sh` carries on past a failing command, so without this only the last line can fail the hook. */
const EXIT = ' || exit 1'

/**
 * A line that enters a directory first, since git runs hooks at the top of the working tree, in a
 * subshell so the `cd` does not carry over to the next line.
 */
const ENTERS = /^\(cd "([^"]*)" && (.*)\)$/
const OLD_ENTERS = /^cd "([^"]*)" && (.*)$/

function hookLine(inside: string, command: string): string {
  return inside === '' ? `${command}${EXIT}` : `(cd "${inside}" && ${command})${EXIT}`
}

/**
 * The directory and command of a hook line that runs `uncheck staged`, or `undefined` when the line
 * is not one `prepare` writes. A line only counts as ours when it runs the command directly or
 * through a package manager, so a line that merely mentions it, or runs it some other way, is left
 * alone.
 */
function ownLine(text: string): { readonly inside: string; readonly command: string } | undefined {
  const line = text.trim()
  const body = line.endsWith(EXIT) ? line.slice(0, -EXIT.length) : line
  const enters = ENTERS.exec(body) ?? OLD_ENTERS.exec(body)
  const command = enters?.[2] ?? body

  const runs = ['', ...EXECS.map((exec) => `${exec} `)].some((prefix) => {
    const rest = command.startsWith(prefix) ? command.slice(prefix.length) : undefined

    return rest === HOOK_COMMAND || rest?.startsWith(`${HOOK_COMMAND} `) === true
  })

  return runs ? { inside: enters?.[1] ?? '', command } : undefined
}

export const prepare = Command.make(
  'prepare',
  {
    cwd: cwdFlag,
    preCommit: Flag.Boolean('pre-commit').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'Write the git pre-commit hook, which runs `uncheck staged` on the files of every commit',
      ),
    ),
    fix: Flag.Boolean('fix').pipe(
      Flag.withDefault(true),
      Flag.withDescription(
        'Have the hook apply and stage fixes as well as report. On by default, --no-fix only checks',
      ),
    ),
    only: onlyFlag,
    required: requireFlag,
    skipped: skipFlag,
  },
  Effect.fn(function* ({ cwd: directory, preCommit, fix, ...selection }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* validateSelection(selection)

    if (!preCommit) {
      return yield* userError(
        'Nothing to prepare. Pass --pre-commit to write the git hook that runs `uncheck staged --fix` before every commit.',
      )
    }

    const cwd = path.resolve(directory)

    const repository = yield* Effect.all([
      git(cwd, ['rev-parse', '--show-toplevel']),
      git(cwd, ['rev-parse', '--git-path', 'hooks']),
    ]).pipe(Effect.option)

    // A `prepare` script runs on every install, including where there is no repository to hook.
    if (Option.isNone(repository)) {
      return yield* Console.log(`${dim('○')} no git repository found, nothing to prepare`)
    }

    const [top, hooks] = repository.value.map((line) => line.trim())
    const exec = yield* detectExec(cwd)
    const command = [
      exec,
      HOOK_COMMAND,
      ...(fix ? ['--fix'] : []),
      ...selectionArgs(selection),
    ].join(' ')

    // Git runs hooks at the top of the working tree, so a project below it is entered first.
    const inside = path.relative(top!, yield* fs.realPath(cwd)).replaceAll('\\', '/')
    const line = hookLine(inside, command)

    const file = path.join(path.resolve(cwd, hooks!), 'pre-commit')
    const relative = path.relative(cwd, file)
    const shown = relative.startsWith('..') ? file : relative
    const existing = yield* fs.readFileString(file).pipe(Effect.option)
    const next = Option.isNone(existing)
      ? `${HEADER}${line}\n`
      : rewrite(existing.value, line, inside)
    const result = Option.isNone(existing)
      ? 'created'
      : next === existing.value
        ? 'unchanged'
        : 'updated'

    const refused = yield* Effect.gen(function* () {
      if (result !== 'unchanged') {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, next)
      }

      yield* fs.chmod(file, 0o755)
    }).pipe(
      Effect.as(undefined),
      Effect.catch((error) =>
        Effect.succeed(error.cause instanceof Error ? error.cause.message : error.message),
      ),
    )

    // `prepare` runs on every install, so an unwritable hook says so rather than failing the install.
    if (refused !== undefined) {
      return yield* Console.log(
        `${red('✘')} ${bold('pre-commit')} ${dim(`${shown} not written, ${refused}`)}`,
      )
    }

    yield* Console.log(`${green('✔')} ${bold('pre-commit')} ${dim(`${shown} ${result}`)}`)
    yield* Console.log('')
    yield* Console.log(
      `${dim('The hook runs')} ${bold(command)} ${dim('before every commit, `git commit --no-verify` skips it.')}`,
    )
  }),
).pipe(
  Command.withDescription(
    'Set up git hooks, for the `prepare` script in package.json so every clone gets them: --pre-commit writes the hook that runs `uncheck staged --fix`',
  ),
)

/**
 * Puts `line` into an existing hook, so running `prepare` again is idempotent: the line for this
 * directory is updated wherever it sits, duplicates of it are dropped, and everything else is kept,
 * including the commands of other packages in the same repository and whatever the user added.
 */
function rewrite(hook: string, line: string, inside: string): string {
  let placed = false
  const lines = hook.split('\n').flatMap((text) => {
    const own = ownLine(text)

    if (own === undefined) {
      return [text]
    }

    if (own.inside !== inside) {
      return [hookLine(own.inside, own.command)]
    }

    if (placed) {
      return []
    }

    placed = true

    return [line]
  })
  const next = lines.join('\n')

  if (placed) {
    return next
  }

  const kept = next === '' || next.endsWith('\n') ? next : `${next}\n`

  return `${kept}${line}\n`
}
