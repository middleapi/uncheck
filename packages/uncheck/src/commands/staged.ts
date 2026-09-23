import { Console, Effect, FileSystem, Path, Ref } from 'effect'
import { Command } from 'effect/unstable/cli'

import { userError } from '../errors'
import { git, GitFailed, gitPaths } from '../git'
import { dim, green, listFiles, red } from '../style'
import { argvBatches } from '../tool'
import {
  checkPaths,
  cwdFlag,
  fixFlag,
  onlyFlag,
  requireFlag,
  skipFlag,
  validateSelection,
} from './uncheck'

/** What became of the unstaged hunks that were set aside while the checks ran. */
type Unstaged = 'restored' | 'conflicted' | 'stranded'

export const staged = Command.make(
  'staged',
  { cwd: cwdFlag, fix: fixFlag, only: onlyFlag, required: requireFlag, skipped: skipFlag },
  Effect.fn(
    function* ({ cwd: directory, fix, ...selection }) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* validateSelection(selection)

      const cwd = path.resolve(directory)

      // Staged deletions and submodules have nothing to check.
      const files = yield* gitPaths(cwd, [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACMR',
        '--ignore-submodules=all',
        '--relative',
        '-z',
      ]).pipe(
        Effect.catchTag('GitFailed', () => userError('`uncheck staged` needs a git repository')),
      )

      yield* Console.log(dim(`uncheck staged in ${cwd}`))

      if (files.length === 0) {
        return yield* Console.log(`${dim('○')} nothing to check, no staged files`)
      }

      const saved = path.resolve(
        cwd,
        (yield* git(cwd, ['rev-parse', '--git-path', 'uncheck-unstaged'])).trim(),
      )

      // A run that was killed, or could not put them back, left the only copy of unstaged changes.
      if (yield* fs.exists(saved)) {
        return yield* leftover(saved)
      }

      const partial = yield* partiallyStaged(cwd, files)
      const before = yield* writeTree(cwd)
      const outcome = yield* Ref.make<Unstaged>('restored')

      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            yield* Effect.acquireRelease(setAside(cwd, saved, partial), (bases) =>
              putBack(cwd, saved, files, partial, bases, before).pipe(
                Effect.flatMap((result) => Ref.set(outcome, result)),
              ),
            )
          }

          const failed = yield* checkPaths(files, {
            ...selection,
            cwd,
            fix,
            allowUnmatched: true,
          }).pipe(
            Effect.map(() => undefined),
            Effect.catchTag('CheckFailed', (error) => Effect.succeed(error)),
          )

          if (fix) {
            yield* Effect.forEach(
              argvBatches(files),
              (batch) => git(cwd, ['add', '--', ...batch]),
              { discard: true },
            )

            const after = yield* writeTree(cwd)

            if (after !== before) {
              const fixed = yield* gitPaths(cwd, [
                'diff-tree',
                '-r',
                '--name-only',
                '--relative',
                '-z',
                before,
                after,
              ])

              yield* Console.log(`${green('✔')} staged the fixes to ${listFiles(fixed)}`)
            }
          }

          return failed
        }),
      )

      const unstagedOutcome = yield* Ref.get(outcome)

      if (unstagedOutcome === 'conflicted') {
        return yield* userError(
          `The fixes conflict with the unstaged changes of ${listFiles(partial)} and were undone. Stage the whole file, or stash its unstaged changes, then commit again.`,
        )
      }

      if (unstagedOutcome === 'stranded') {
        return yield* userError(
          `The unstaged changes of ${listFiles(partial)} could not be put back, see above.`,
        )
      }

      if (failure !== undefined) {
        return yield* Effect.fail(failure)
      }
    },
    Effect.catchTag('GitFailed', (error) => userError(`${error.command} failed: ${error.stderr}`)),
  ),
).pipe(
  Command.withDescription(
    'Check the files staged for commit, what a pre-commit hook runs. With --fix the fixes are staged too, and unstaged changes stay unstaged',
  ),
)

const writeTree = (cwd: string) => Effect.map(git(cwd, ['write-tree']), (sha) => sha.trim())

const leftover = (saved: string) =>
  userError(
    `An earlier run left the unstaged versions of your files in ${saved}, or another run is using it. Copy back what your files are missing, delete the folder, then commit again.`,
  )

/** Only edits to plain files can be set aside: `100644` or `100755` in the index and on disk. */
const PLAIN = /^100(?:644|755)$/

/**
 * The staged `files` that also have unstaged changes. A deleted file, a symlink or a type change
 * among them stops the run before anything is touched.
 */
const partiallyStaged = Effect.fn(function* (cwd: string, files: ReadonlyArray<string>) {
  // `:<index mode> <file mode> <index id> <file id> <status>` then the path, NUL separated.
  const entries = (yield* git(cwd, ['diff', '--raw', '--relative', '-z'])).split('\0')
  const partial: string[] = []
  const odd: string[] = []

  for (let index = 0; index + 1 < entries.length; index += 2) {
    const file = entries[index + 1]!

    if (files.includes(file)) {
      const modes = entries[index]!.slice(1).split(' ').slice(0, 2)
      ;(modes.every((mode) => PLAIN.test(mode)) ? partial : odd).push(file)
    }
  }

  if (odd.length > 0) {
    return yield* userError(
      `The unstaged changes of ${listFiles(odd)} are not edits to a file and cannot be set aside. Stage or stash them, then commit again.`,
    )
  }

  return partial
})

/**
 * Copies the partially staged `files` into `saved`, then checks them out so the checks see what will
 * be committed, and returns that staged content, the base putBack merges from. Should anything
 * fail after the copies exist, they go back and nothing is set aside.
 */
const setAside = Effect.fn(function* (cwd: string, saved: string, files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const copies = files.map((file) => [path.join(cwd, file), path.join(saved, file)] as const)

  // Creating the folder, not only finding it missing, is what claims it from a parallel run.
  yield* fs.makeDirectory(saved).pipe(Effect.catch(() => leftover(saved)))
  yield* Effect.forEach(
    copies,
    ([file, copy]) =>
      fs
        .makeDirectory(path.dirname(copy), { recursive: true })
        .pipe(Effect.andThen(fs.copyFile(file, copy))),
    { discard: true },
  ).pipe(Effect.tapError(() => Effect.ignore(fs.remove(saved, { recursive: true }))))

  return yield* Effect.gen(function* () {
    yield* Effect.forEach(argvBatches(files), (batch) => git(cwd, ['checkout', '--', ...batch]), {
      discard: true,
    })
    yield* Console.log(
      dim(`○ unstaged changes of ${listFiles(files)} set aside until the checks finish`),
    )

    return yield* Effect.forEach(copies, ([file]) => fs.readFile(file))
  }).pipe(
    Effect.tapError(() =>
      Effect.forEach(copies, ([file, copy]) => fs.copyFile(copy, file), { discard: true }).pipe(
        Effect.andThen(fs.remove(saved, { recursive: true })),
        Effect.ignore,
      ),
    ),
  )
})

/**
 * Puts the unstaged changes back on top of the fixes: a file the checks left as it was gets its copy
 * back, any other gets what `git merge-file` makes of the copy and the fixes. When a fix and an
 * unstaged change touch the same lines, the fixes are undone on every staged file and the copies go
 * back. Never fails, since it runs as a finalizer: what it could not do is reported and returned,
 * and the copies stay in `saved` then.
 */
const putBack = Effect.fn(function* (
  cwd: string,
  saved: string,
  files: ReadonlyArray<string>,
  partial: ReadonlyArray<string>,
  bases: ReadonlyArray<Uint8Array>,
  before: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const copies = partial.map((file) => [path.join(cwd, file), path.join(saved, file)] as const)

  const result = yield* Effect.gen(function* () {
    const merged = yield* Effect.forEach(copies, ([file, copy], index) =>
      merge(cwd, file, copy, bases[index]!),
    )

    if (merged.every(Boolean)) {
      yield* Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`))
      return 'restored' as const
    }

    yield* Effect.forEach(
      argvBatches(files),
      (batch) =>
        git(cwd, ['restore', `--source=${before}`, '--staged', '--worktree', '--', ...batch]),
      { discard: true },
    )
    yield* Effect.forEach(copies, ([file, copy]) => fs.copyFile(copy, file), { discard: true })

    return 'conflicted' as const
  }).pipe(
    Effect.catch((error) => {
      const reason =
        error instanceof GitFailed ? `${error.command} failed, ${error.stderr}` : String(error)

      return Console.log(
        `${red('✘')} could not put back the unstaged changes of ${listFiles(partial)}: ${reason}\n  their unstaged versions are in ${saved}, copy back what your files are missing and delete the folder`,
      ).pipe(Effect.as('stranded' as const))
    }),
  )

  if (result !== 'stranded') {
    yield* Effect.ignore(fs.remove(saved, { recursive: true }))
  }

  return result
})

/**
 * Writes to `file` its unstaged `copy` plus whatever the checks changed since `base`, or returns
 * false when both touch the same lines. `merge-file`, unlike `apply --3way`, ignores the merge
 * drivers and rerere a repository may configure.
 */
const merge = Effect.fn(function* (cwd: string, file: string, copy: string, base: Uint8Array) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const checked = yield* fs.readFile(file)

  if (checked.length === base.length && checked.every((byte, index) => byte === base[index])) {
    yield* fs.copyFile(copy, file)
    return true
  }

  const temp = yield* fs.makeTempDirectory()
  const [result, original] = [path.join(temp, 'result'), path.join(temp, 'base')]

  return yield* Effect.gen(function* () {
    // The result starts as the copy, so it keeps the copy's file mode.
    yield* fs.copyFile(copy, result)
    yield* fs.writeFile(original, base)

    const clean = yield* git(cwd, ['merge-file', '--quiet', result, original, file]).pipe(
      Effect.as(true),
      Effect.catchTag('GitFailed', () => Effect.succeed(false)),
    )

    if (clean) {
      yield* fs.copyFile(result, file)
    }

    return clean
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temp, { recursive: true }))))
})
