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

      const repo = yield* repoPaths(cwd)

      // A run that was killed, or could not put them back, left unstaged changes in the patch only.
      if (yield* fs.exists(repo.patch)) {
        return yield* userError(
          `An earlier run left unstaged changes in ${repo.patch}. Put them back with \`${applyByHand(repo)}\`, which refuses if your files already have them, then delete the file and commit again.`,
        )
      }

      const unstaged = yield* gitPaths(cwd, ['diff', '--name-only', '--relative', '-z'])
      const partial = files.filter((file) => unstaged.includes(file))
      const before = yield* writeTree(cwd)
      const outcome = yield* Ref.make<Unstaged>('restored')

      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            // Once the patch is saved, putBack runs however the rest ends, a failed checkout included.
            yield* Effect.acquireRelease(savePatch(cwd, repo.patch, partial), () =>
              putBack(cwd, repo, files, partial, before).pipe(
                Effect.flatMap((result) => Ref.set(outcome, result)),
              ),
            )
            yield* Effect.forEach(
              argvBatches(partial),
              (batch) => git(cwd, ['checkout', '--', ...batch]),
              { discard: true },
            )
            yield* Console.log(
              dim(`○ unstaged changes of ${listFiles(partial)} set aside until the checks finish`),
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

/**
 * The repository of `cwd`: its top folder and index, where the unstaged hunks are kept while the
 * checks run, and the copy of the index they are merged into.
 */
const repoPaths = Effect.fn(function* (cwd: string) {
  const path = yield* Path.Path
  const output = yield* git(cwd, [
    'rev-parse',
    '--show-toplevel',
    '--git-path',
    'index',
    '--git-path',
    'uncheck-unstaged.patch',
    '--git-path',
    'uncheck-index',
  ])
  const [top, index, patch, merged] = output
    .trim()
    .split('\n')
    .map((line) => path.resolve(cwd, line))

  return { top: top!, index: index!, patch: patch!, merged: merged! }
})

type RepoPaths = Effect.Success<ReturnType<typeof repoPaths>>

/** Plain `git apply` refuses rather than guess, and it skips files outside the folder it runs in. */
const applyByHand = ({ top, patch }: RepoPaths) => `git -C "${top}" apply "${patch}"`

/**
 * Saves the unstaged hunks of `files` as a patch. Unlike `git diff`, `diff-files` ignores settings
 * such as `diff.relative` or `diff.context` that would make the patch unfit for `git apply`, and
 * `GIT_DIFF_OPTS` is cleared for the same reason. A half-written patch is removed, since the files
 * still hold every change then.
 */
const savePatch = Effect.fn(function* (cwd: string, patch: string, files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem

  yield* git(cwd, ['diff-files', '--patch', '--binary', `--output=${patch}`, '--', ...files], {
    GIT_DIFF_OPTS: undefined,
  }).pipe(Effect.tapError(() => Effect.ignore(fs.remove(patch))))
})

/**
 * Puts the unstaged hunks back on top of the fixes. `--3way` follows what the fixes did, and it
 * runs on a copy of the index so the hunks stay unstaged. When a fix and a hunk touch the same
 * lines, the fixes are undone on every staged file, which makes the files what the patch was taken
 * from, so it applies as it is. Never fails, since it runs as a finalizer: what it could not do is
 * reported and returned.
 */
const putBack = Effect.fn(function* (
  cwd: string,
  repo: RepoPaths,
  files: ReadonlyArray<string>,
  partial: ReadonlyArray<string>,
  before: string,
) {
  const fs = yield* FileSystem.FileSystem

  const result = yield* Effect.gen(function* () {
    const restored = yield* fs.copyFile(repo.index, repo.merged).pipe(
      Effect.andThen(
        git(cwd, ['apply', '--3way', '--whitespace=nowarn', repo.patch], {
          GIT_INDEX_FILE: repo.merged,
        }),
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )

    if (restored) {
      yield* Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`))
      return 'restored' as const
    }

    yield* Effect.forEach(
      argvBatches(files),
      (batch) =>
        git(cwd, ['restore', `--source=${before}`, '--staged', '--worktree', '--', ...batch]),
      { discard: true },
    )
    yield* git(cwd, ['apply', '--whitespace=nowarn', repo.patch])

    return 'conflicted' as const
  }).pipe(
    Effect.catch((error) => {
      const reason =
        error instanceof GitFailed ? `${error.command} failed, ${error.stderr}` : String(error)

      return Console.log(
        `${red('✘')} could not put back the unstaged changes of ${listFiles(partial)}: ${reason}\n  they are saved in ${repo.patch}, put them back with \`${applyByHand(repo)}\` and delete the file`,
      ).pipe(Effect.as('stranded' as const))
    }),
    Effect.ensuring(Effect.ignore(fs.remove(repo.merged))),
  )

  if (result !== 'stranded') {
    yield* Effect.ignore(fs.remove(repo.patch))
  }

  return result
})
