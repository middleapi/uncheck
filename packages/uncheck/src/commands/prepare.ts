import { randomBytes } from 'node:crypto'

import { Console, Effect, FileSystem, Option, Path, Result, Schedule } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { userError } from '../errors'
import { git } from '../git'
import { detectExec, invokes } from '../pm'
import { bold, dim, green, red } from '../style'
import { cwdFlag, selectionArgs, selectionFlags, validateSelection } from './uncheck'

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

/** Git runs a hook through its shebang, where a line of `sh` would be a syntax error. */
const OTHER_INTERPRETER = /^#!(?!.*\b(?:ba|da|k|z|a)?sh\b)/

/**
 * `sh` still expands `$`, backticks and `\` between double quotes, `"` ends them, and a newline ends
 * the hook line.
 */
const UNQUOTABLE = /["$`\\\n]/

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

  return invokes(command, HOOK_COMMAND) ? { inside: enters?.[1] ?? '', command } : undefined
}

// `sh` reads a script while running it, so a hook rewritten in place makes a commit already running
// it carry on from the same byte offset in the new content.
const replaceFile = Effect.fn(function* (file: string, content: string, mode: number | undefined) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporary = path.join(
    path.dirname(file),
    `${path.basename(file)}.uncheck-${randomBytes(6).toString('hex')}`,
  )

  yield* fs.writeFileString(temporary, content, { flag: 'wx' }).pipe(
    Effect.andThen(mode === undefined ? Effect.void : fs.chmod(temporary, mode)),
    Effect.andThen(fs.rename(temporary, file)),
    Effect.onError(() => Effect.ignore(fs.remove(temporary))),
  )
})

// A workspace install runs the `prepare` script of every package at once, all rewriting one hook.
function locked<A, E, R>(file: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lock = `${file}.lock`

    return yield* Effect.acquireUseRelease(
      fs.writeFileString(lock, '', { flag: 'wx' }).pipe(
        Effect.retry({
          while: (error) => error.reason._tag === 'AlreadyExists',
          schedule: Schedule.spaced('20 millis'),
          times: 500,
        }),
      ),
      () => effect,
      () => Effect.ignore(fs.remove(lock)),
    )
  })
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
    allowEmpty: Flag.Boolean('allow-empty').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'Have the hook let a commit through when the fixes undo every staged change, which makes it empty',
      ),
    ),
    ...selectionFlags,
  },
  Effect.fn(function* ({ cwd: directory, preCommit, fix, allowEmpty, ...selection }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* validateSelection(selection)

    if (!preCommit) {
      return yield* userError(
        'Nothing to prepare. Pass --pre-commit to write the git hook that runs `uncheck staged --fix` before every commit.',
      )
    }

    const cwd = path.resolve(directory)

    const repository = yield* git(cwd, [
      'rev-parse',
      '--show-toplevel',
      '--show-prefix',
      '--git-path',
      'hooks',
    ]).pipe(Effect.option)

    // A `prepare` script runs on every install, including where there is no repository to hook.
    if (Option.isNone(repository)) {
      return yield* Console.log(`${dim('○')} no git repository found, nothing to prepare`)
    }

    // A newline in a path shifts the lines git prints, so they are split to land it in `inside`.
    const [, ...printed] = repository.value.split('\n')
    const hooks = printed.pop() ?? ''
    const inside = printed.join('\n').replace(/\/$/, '')
    const exec = yield* detectExec(cwd)
    const command = [
      exec,
      HOOK_COMMAND,
      ...(fix ? ['--fix'] : []),
      ...(allowEmpty ? ['--allow-empty'] : []),
      ...selectionArgs(selection),
    ].join(' ')
    const line = hookLine(inside, command)

    // husky 9 and Vite+ point core.hooksPath at a `_` folder of generated shims that source the `h`
    // dispatcher, which exits before any line appended to a shim and runs the hook in the folder above.
    const configured = path.resolve(cwd, hooks)
    const dispatched =
      path.basename(configured) === '_' &&
      (yield* fs.exists(path.join(configured, 'h')).pipe(Effect.orElseSucceed(() => false)))
    const file = path.join(dispatched ? path.dirname(configured) : configured, 'pre-commit')
    const relative = path.relative(cwd, file)
    const shown = relative.startsWith('..') ? file : relative
    const shared = yield* git(cwd, ['config', '--show-scope', '--get', 'core.hooksPath']).pipe(
      Effect.map((scoped) => /^(global|system)\t/.exec(scoped)?.[1]),
      Effect.orElseSucceed(() => undefined),
    )

    const written = yield* Effect.gen(function* () {
      if (shared !== undefined) {
        return yield* Effect.fail(
          `core.hooksPath is set in the ${shared} git config, so every repository runs it`,
        )
      }

      if (UNQUOTABLE.test(inside)) {
        return yield* Effect.fail(
          `sh would misread the folder name ${JSON.stringify(inside)} between double quotes`,
        )
      }

      // Renaming over a symlinked hook would replace the link, not the script it points to.
      const target = yield* fs.realPath(file).pipe(
        Effect.catch(() => fs.readLink(file)),
        Effect.map((link) => path.resolve(path.dirname(file), link)),
        Effect.orElseSucceed(() => file),
      )

      yield* fs.makeDirectory(path.dirname(target), { recursive: true })

      return yield* locked(
        target,
        Effect.gen(function* () {
          const existing = yield* fs
            .readFileString(target)
            .pipe(Effect.orElseSucceed(() => undefined))

          if (existing !== undefined && OTHER_INTERPRETER.test(existing)) {
            return yield* Effect.fail(`it is not a shell script, have it run \`${line}\` yourself`)
          }

          const next = rewrite(existing ?? HEADER, line, inside)
          const result =
            existing === undefined ? 'created' : next === existing ? 'unchanged' : 'updated'

          // The dispatcher runs the hook with `sh`, and flipping the mode of a committed hook would
          // leave every clone with a change to commit.
          if (result === 'unchanged') {
            if (!dispatched) {
              yield* fs.chmod(target, 0o755)
            }

            return result
          }

          const mode = dispatched
            ? yield* fs.stat(target).pipe(
                Effect.map((info) => info.mode & 0o7777),
                Effect.orElseSucceed(() => undefined),
              )
            : 0o755

          yield* replaceFile(target, next, mode)

          return result
        }),
      )
    }).pipe(
      Effect.mapError((error) =>
        typeof error === 'string'
          ? error
          : error.cause instanceof Error
            ? error.cause.message
            : error.message,
      ),
      Effect.result,
    )

    // `prepare` runs on every install, so a hook it may not write says so rather than failing it.
    if (Result.isFailure(written)) {
      return yield* Console.log(
        `${red('✘')} ${bold('pre-commit')} ${dim(`${shown} not written, ${written.failure}`)}`,
      )
    }

    yield* Console.log(`${green('✔')} ${bold('pre-commit')} ${dim(`${shown} ${written.success}`)}`)
    yield* Console.log('')
    yield* Console.log(
      `${dim('The hook runs')} ${bold(command)} ${dim('before every commit, `git commit --no-verify` skips it.')}`,
    )
  }),
).pipe(
  Command.withDescription(
    'Set up git hooks, for the `prepare` script in package.json (`postinstall` with Yarn 2+) so every clone gets them: --pre-commit writes the hook that runs `uncheck staged --fix`',
  ),
)

/**
 * Puts `line` into a hook, so running `prepare` again is idempotent: the line for this directory is
 * updated wherever it sits, duplicates of it are dropped, and everything else is kept, including the
 * commands of other packages in the same repository and whatever the user added.
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

  if (placed) {
    return lines.join('\n')
  }

  // Added after the commands of the hook, the line would set its exit status in their place, and
  // would never run after an `exec` or `exit`. Before a sourced file it would run twice with husky 8,
  // whose `_/husky.sh` runs the hook again.
  const after = lines.reduce(
    (last, text, index) => (ownLine(text) === undefined ? last : index + 1),
    0,
  )
  const at = after > 0 ? after : lines.findIndex((text) => !/^\s*(?:#|\.\s|$)/.test(text))

  if (at === -1) {
    const kept = lines.join('\n')

    return `${kept === '' || kept.endsWith('\n') ? kept : `${kept}\n`}${line}\n`
  }

  lines.splice(at, 0, line)

  return lines.join('\n')
}
