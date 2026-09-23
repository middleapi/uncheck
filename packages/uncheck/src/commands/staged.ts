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
      const path = yield* Path.Path

      yield* validateSelection(selection)

      const cwd = path.resolve(directory)

      // Staged deletions have nothing left to check.
      const files = yield* gitPaths(cwd, [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACMR',
        '--relative',
        '-z',
      ]).pipe(
        Effect.catchTag('GitFailed', () => userError('`uncheck staged` needs a git repository')),
      )

      yield* Console.log(dim(`uncheck staged in ${cwd}`))

      if (files.length === 0) {
        return yield* Console.log(`${dim('○')} nothing to check, no staged files`)
      }

      const unstaged = yield* gitPaths(cwd, ['diff', '--name-only', '--relative', '-z'])
      const partial = files.filter((file) => unstaged.includes(file))
      const before = yield* writeTree(cwd)
      const outcome = yield* Ref.make<Unstaged>('restored')

      const { failure, empty } = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            yield* Effect.acquireRelease(setAside(cwd, partial), (patch) =>
              putBack(cwd, patch, files, partial, before).pipe(
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

            return { failure: failed, empty: after === (yield* headTree(cwd)) }
          }

          return { failure: failed, empty: false }
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

      if (empty) {
        return yield* userError(
          'The fixes undid every staged change, so the commit would be empty. To commit a change the fixes undo, make it again and commit with `git commit --no-verify`.',
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

const headTree = (cwd: string) =>
  git(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{tree}']).pipe(
    Effect.map((sha) => sha.trim()),
    Effect.catchTag('GitFailed', () => Effect.succeed(undefined)),
  )

const apply = (cwd: string, patch: string) =>
  git(cwd, ['apply', '--whitespace=nowarn', '--recount', '--unidiff-zero', patch])

/**
 * Saves the unstaged hunks of the partially staged `files` as a patch and takes them out of the
 * working tree, so the checks see what will be committed. Zero context lines keep the patch
 * applicable once the fixes have changed lines around the hunks.
 */
const setAside = Effect.fn(function* (cwd: string, files: ReadonlyArray<string>) {
  const path = yield* Path.Path
  const patch = path.resolve(
    cwd,
    (yield* git(cwd, ['rev-parse', '--git-path', 'uncheck-unstaged.patch'])).trim(),
  )

  yield* git(cwd, [
    'diff',
    '--binary',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `--output=${patch}`,
    '--',
    ...files,
  ])

  yield* Effect.forEach(argvBatches(files), (batch) => git(cwd, ['checkout', '--', ...batch]), {
    discard: true,
  }).pipe(
    // Giving up halfway would leave the hunks in the patch only, so put them back first.
    Effect.tapError(() => Effect.ignore(apply(cwd, patch))),
  )

  yield* Console.log(
    dim(`○ unstaged changes of ${listFiles(files)} set aside until the checks finish`),
  )

  return patch
})

/**
 * Puts the unstaged hunks back on top of the fixes. When they no longer apply, the fixes are undone
 * on every staged file, which makes the files what the patch was taken from, so it applies again.
 * Never fails, since it runs as a finalizer: what it could not do is reported and returned.
 */
const putBack = Effect.fn(function* (
  cwd: string,
  patch: string,
  files: ReadonlyArray<string>,
  partial: ReadonlyArray<string>,
  before: string,
) {
  const fs = yield* FileSystem.FileSystem

  const result = yield* Effect.gen(function* () {
    const applied = yield* apply(cwd, patch).pipe(
      Effect.map(() => true),
      Effect.catchTag('GitFailed', () => Effect.succeed(false)),
    )

    if (applied) {
      yield* Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`))
      return 'restored' as const
    }

    yield* Effect.forEach(
      argvBatches(files),
      (batch) =>
        git(cwd, ['restore', `--source=${before}`, '--staged', '--worktree', '--', ...batch]),
      { discard: true },
    )
    yield* apply(cwd, patch)

    return 'conflicted' as const
  }).pipe(
    Effect.catch((error) => {
      const reason =
        error instanceof GitFailed ? `${error.command} failed, ${error.stderr}` : String(error)

      return Console.log(
        `${red('✘')} could not put back the unstaged changes of ${listFiles(partial)}: ${reason}\n  they are saved in ${patch}, apply them with: git apply --unidiff-zero ${patch}`,
      ).pipe(Effect.as('stranded' as const))
    }),
  )

  if (result !== 'stranded') {
    yield* Effect.ignore(fs.remove(patch))
  }

  return result
})
