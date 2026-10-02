import { randomBytes } from 'node:crypto'

import { Console, Effect, FileSystem, Option, Path, Result, Schedule } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { platformMessage, userError } from '../errors'
import { readTextIfExists } from '../files'
import { git, gitLocation, refusesRepository } from '../git'
import { detectExec, invokes } from '../pm'
import { bold, dim, green, red } from '../style'
import type { CheckSelection } from './uncheck'
import { cwdFlag, selectionArgs, selectionFlags, validateSelection } from './uncheck'

const HOOK_COMMAND = 'uncheck staged'
const HEADER = '#!/bin/sh\n# Written by `uncheck prepare`, run it again to change the command.\n'

/** `sh` carries on past a failing command, so without this only the last line can fail the hook. */
const EXIT = ' || exit 1'

/**
 * A line that enters a directory first, since git runs hooks at the top of the working tree, in a
 * subshell so the `cd` does not carry over to the next line.
 */
const ENTERS_WHEN_STAGED =
  /^git --literal-pathspecs diff --cached --quiet -- "([^"]*)" \|\| \[ ! -d "\1" \] \|\| \(cd "\1" && (.*)\)$/
const ENTERS = /^\(cd "([^"]*)" && (.*)\)$/
const OLD_ENTERS = /^cd "([^"]*)" && (.*)$/

const CWD_FLAG = / --cwd=/

/** Git runs a hook through its shebang, where a line of `sh` would be a syntax error. */
const OTHER_INTERPRETER = /^#!(?!.*\b(?:ba|da|k|z|a)?sh\b)/

/** Invalid UTF-8 reads back as U+FFFD, so writing such a hook back would replace those bytes. */
const NOT_TEXT = /[\0\uFFFD]/

/** The comments and environment a hook sets up, such as its PATH, which the added line needs too. */
const SETUP =
  /^\s*(?:$|\\?\.\s|(?:(?:source|export|set|unset)\s|(?:\[|test)\s[^;&|]*&&\s*(?:\\?\.|source)\s)[^;&|]*$|[A-Za-z_]\w*=\S*\s*$)/

/** husky 4 sources this runner, which always exits, so nothing after it runs. */
const HUSKY_4_RUNNER = /^\.\s+"\$\(dirname "\$0"\)\/husky\.sh"\s*$/

const INNERMOST_SUBSTITUTION = /\$\([^()]*\)/g

// A `\"` outside quotes opens nothing, and a `"` between single quotes opens nothing either.
const QUOTED = /\\.|"(?:[^"\\]|\\.)*"|'[^']*'/g

const COMMENT = /(?:^|\s)#.*$/

/**
 * A line that runs on into the next, so a line added after it would join its command or block, and
 * one removed after it would leave them incomplete.
 */
const CONTINUES =
  /^(?:.*\\\s*$|(?:[^"]*"[^"]*")*[^"]*"[^"]*$|(?:[^']*'[^']*')*[^']*'[^']*$|(?:[^`]*`[^`]*`)*[^`]*`[^`]*$|.*[({]\s*$|.*<<|.*(?:&&|\||(?:^|[\s;])(?:if|then|elif|else|while|until|do))\s*$)/

const INDENT = /^\s*/

/**
 * `sh` still expands `$`, backticks and `\` between double quotes, `"` ends them, and a newline ends
 * the hook line.
 */
const UNQUOTABLE = /["$`\\\n]/

// Without --literal-pathspecs, git reads a folder whose name starts with `:` as pathspec magic.
function hookLine(inside: string, command: string): string {
  return inside === ''
    ? `${command}${EXIT}`
    : `git --literal-pathspecs diff --cached --quiet -- "${inside}" || [ ! -d "${inside}" ] || (cd "${inside}" && ${command})${EXIT}`
}

/**
 * The directory and command of a hook line that runs `uncheck staged`, or `undefined` when the line
 * is not one `prepare` writes. A line only counts as ours when it runs the command directly or
 * through a package manager, so a line that merely mentions it, or runs it some other way, such as
 * in another directory with `--cwd`, is left alone.
 */
function ownLine(text: string): { readonly inside: string; readonly command: string } | undefined {
  const line = text.trim()
  const body = line.endsWith(EXIT) ? line.slice(0, -EXIT.length) : line
  const enters = ENTERS_WHEN_STAGED.exec(body) ?? ENTERS.exec(body) ?? OLD_ENTERS.exec(body)
  const command = enters?.[2] ?? body

  return invokes(command, HOOK_COMMAND) && !CWD_FLAG.test(command)
    ? { inside: enters?.[1] ?? '', command }
    : undefined
}

/**
 * A `;`, `&` or `|` between quotes or in a command substitution does not end the command, and a
 * quote in a comment opens nothing.
 */
function codeOf(text: string): string {
  const substituted = text.replace(INNERMOST_SUBSTITUTION, '_')

  return substituted === text
    ? text.replace(QUOTED, (token) => (token.startsWith('\\') ? token : '""')).replace(COMMENT, '')
    : codeOf(substituted)
}

function indentOf(text: string): string {
  return INDENT.exec(text)![0]
}

// prepare never indents its lines nor continues another line into them, so such a line is the
// user's, and dropping or moving it would break the block or command it is in.
function standalone(texts: ReadonlyArray<string>, index: number): boolean {
  const previous = texts
    .slice(0, index)
    .filter((text) => codeOf(text).trim() !== '')
    .at(-1)

  return (
    indentOf(texts[index]!) === '' && (previous === undefined || !CONTINUES.test(codeOf(previous)))
  )
}

function writtenByV003(text: string): boolean {
  const own = ownLine(text)

  return (
    own !== undefined &&
    text === (own.inside === '' ? own.command : `cd "${own.inside}" && ${own.command}`)
  )
}

// Added after the commands of the hook, a line would set its exit status in their place, and would
// never run after an `exec` or `exit`. Before the hook's setup it would miss the PATH a GUI client
// lacks, and run twice with husky 8, whose sourced `_/husky.sh` runs the hook again.
function beforeCommands(
  texts: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const at = texts.findIndex((text) => {
    const code = codeOf(text)

    return !SETUP.test(code) || HUSKY_4_RUNNER.test(text) || CONTINUES.test(code)
  })

  return at === -1
    ? [...(texts.at(-1) === '' ? texts.slice(0, -1) : texts), ...added, '']
    : [...texts.slice(0, at), ...added, ...texts.slice(at)]
}

/**
 * Older versions appended their lines to the hook, where an `exec` or `exit` before them, or the
 * runner of husky 4, skips them. Only the end of the hook is theirs: v0.0.3 also rewrote the user's
 * lines in place, unindented, in blocks that would be left empty without them.
 */
function liftAppended(texts: ReadonlyArray<string>): ReadonlyArray<string> {
  const runner = texts.findIndex((text) => HUSKY_4_RUNNER.test(text))
  const tail = texts.reduce(
    (start, text, index) => (text.trim() === '' || writtenByV003(text) ? start : index + 1),
    0,
  )
  const from = runner === -1 ? tail : Math.min(tail, runner + 1)
  const appended = texts.map(
    (text, index) => index >= from && ownLine(text) !== undefined && standalone(texts, index),
  )

  return appended.includes(true)
    ? beforeCommands(
        texts.filter((_, index) => !appended[index]),
        texts.filter((_, index) => appended[index]),
      )
    : texts
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

interface PreCommitOptions extends CheckSelection {
  readonly fix: boolean
  readonly allowEmpty: boolean
}

export const writePreCommitHook = Effect.fn(function* (
  cwd: string,
  { fix, allowEmpty, ...selection }: PreCommitOptions,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const repository = yield* gitLocation(cwd, ['hooks']).pipe(Effect.result)

  if (Result.isFailure(repository)) {
    const { failure } = repository

    if (failure._tag === 'GitFailed' && refusesRepository(failure)) {
      const reason = failure.stderr.split('\n')[0]!.replace(/^fatal: /, '')

      return yield* Console.log(
        `${red('✘')} ${bold('pre-commit')} ${dim(`not written, git refuses the repository: ${reason}`)}`,
      )
    }

    // A `prepare` script runs on every install, including where there is no repository to hook.
    return yield* Console.log(`${dim('○')} no git repository found, nothing to prepare`)
  }

  const {
    prefix,
    paths: [hooks],
  } = repository.success
  const inside = prefix.replace(/\/$/, '')
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
  const configured = path.resolve(cwd, hooks!)
  const dispatched =
    path.basename(configured) === '_' &&
    (yield* fs.exists(path.join(configured, 'h')).pipe(Effect.orElseSucceed(() => false)))
  const file = path.join(dispatched ? path.dirname(configured) : configured, 'pre-commit')
  const relative = path.relative(cwd, file)
  const shown = relative.startsWith('..') ? file : relative
  // A scope option turns includes off, and an included file can set a global core.hooksPath.
  const hooksPath = (option: string) =>
    git(cwd, ['config', option, '--includes', '--get', 'core.hooksPath'])
  const shared = yield* hooksPath('--show-scope').pipe(
    Effect.map((scoped) => /^(global|system)\t/.exec(scoped)?.[1]),
    // Git before 2.26 has no --show-scope, which must not pass for an unset core.hooksPath.
    Effect.catchIf(
      (error) => error._tag === 'GitFailed' && error.exitCode === 129,
      () =>
        Effect.findFirst(['local', 'global', 'system'], (scope) =>
          hooksPath(`--${scope}`).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ).pipe(Effect.map(Option.getOrUndefined)),
    ),
    Effect.map((scope) => (scope === 'local' ? undefined : scope)),
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
        const existing = yield* readTextIfExists(target)

        if (
          existing !== undefined &&
          (OTHER_INTERPRETER.test(existing) || NOT_TEXT.test(existing))
        ) {
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
    Effect.mapError((error) => (typeof error === 'string' ? error : platformMessage(error))),
    Effect.result,
  )

  // `prepare` runs on every install, so a hook it may not write says so rather than failing it.
  if (Result.isFailure(written)) {
    return yield* Console.log(
      `${red('✘')} ${bold('pre-commit')} ${dim(`${shown} not written, ${written.failure}`)}`,
    )
  }

  yield* Console.log(`${green('✔')} ${bold('pre-commit')} ${dim(`${shown} ${written.success}`)}`)

  return command
})

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
  Effect.fn(function* ({ cwd: directory, preCommit, ...options }) {
    const path = yield* Path.Path

    yield* validateSelection(options)

    if (!preCommit) {
      return yield* userError(
        'Nothing to prepare. Pass --pre-commit to write the git hook that runs `uncheck staged --fix` before every commit.',
      )
    }

    const command = yield* writePreCommitHook(path.resolve(directory), options)

    if (command !== undefined) {
      yield* Console.log('')
      yield* Console.log(
        `${dim('The hook runs')} ${bold(command)} ${dim('before every commit, `git commit --no-verify` skips it.')}`,
      )
    }
  }),
).pipe(
  Command.withDescription(
    'Set up git hooks, for the `prepare` script in package.json (`postinstall` with Yarn 2+) so every clone gets them: --pre-commit writes the hook that runs `uncheck staged --fix`',
  ),
)

/**
 * Puts `line` into a hook, so running `prepare` again is idempotent: the lines older versions
 * appended are moved up first, every line for this directory is updated where it sits, keeping its
 * indentation, except the standalone copies after the first standalone one, which are dropped, and
 * everything else is kept, including the commands of other packages in the same repository and
 * whatever the user added.
 */
function rewrite(hook: string, line: string, inside: string): string {
  let placed = false
  let placedStandalone = false
  const lines = liftAppended(hook.split('\n')).flatMap((text, index, texts) => {
    const own = ownLine(text)

    if (own === undefined) {
      return [text]
    }

    const indent = indentOf(text)

    if (own.inside !== inside) {
      return [`${indent}${hookLine(own.inside, own.command)}`]
    }

    const isStandalone = standalone(texts, index)

    if (isStandalone && placedStandalone) {
      return []
    }

    placed = true
    placedStandalone ||= isStandalone

    return [`${indent}${line}`]
  })

  if (placed) {
    return lines.join('\n')
  }

  const after = lines.reduce(
    (last, text, index) =>
      ownLine(text) !== undefined && standalone(lines, index) ? index + 1 : last,
    0,
  )

  return (
    after > 0
      ? [...lines.slice(0, after), line, ...lines.slice(after)]
      : beforeCommands(lines, [line])
  ).join('\n')
}
