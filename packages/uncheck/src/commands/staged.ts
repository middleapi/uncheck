import { Console, Effect, FileSystem, Path, Ref } from 'effect'
import { Command } from 'effect/unstable/cli'

import { userError } from '../errors'
import { git, gitBytes, GitFailed, gitPaths } from '../git'
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

      // Copies are kept at their paths from the top, whichever package folder the run starts in.
      const [prefix = '', folder = ''] = (yield* git(cwd, [
        'rev-parse',
        '--show-prefix',
        '--git-path',
        'uncheck-unstaged',
      ])).split('\n')
      const saved = path.resolve(cwd, folder)
      const aside = { cwd, saved, prefix }

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
            yield* Effect.acquireRelease(setAside(aside, partial), (bases) =>
              putBack(aside, files, partial, bases, before).pipe(
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
    `An earlier run left the unstaged versions of your files in ${saved}, at their paths from the top of the repository. Unless another commit is running, copy back what your files are missing, delete the folder, then commit again.`,
  )

/** Only edits to plain files can be set aside: `100644` or `100755` in the index and on disk. */
const PLAIN = /^100(?:644|755)$/

/**
 * The staged `files` that also have unstaged changes. A deleted file, a symlink or a type change
 * among them stops the run before anything is touched.
 */
const partiallyStaged = Effect.fn(function* (cwd: string, files: ReadonlyArray<string>) {
  // `:<index mode> <file mode> <index id> <file id> <status>` then one path, NUL separated.
  const entries = (yield* git(cwd, ['diff', '--raw', '--no-renames', '--relative', '-z'])).split(
    '\0',
  )
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

/** Where a partially staged file lives and where its copy is kept while the checks run. */
interface Aside {
  readonly cwd: string
  readonly saved: string
  readonly prefix: string
}

const copiesOf = Effect.fn(function* ({ cwd, saved, prefix }: Aside, files: ReadonlyArray<string>) {
  const path = yield* Path.Path

  return files.map((file) => [path.join(cwd, file), path.join(saved, prefix, file)] as const)
})

/**
 * Copies the partially staged `files` into the saved folder, then checks them out so the checks see
 * what will be committed, and returns their staged blobs, the base putBack merges from. Should
 * anything fail after the copies exist, they go back and nothing is set aside.
 */
const setAside = Effect.fn(function* (aside: Aside, files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { cwd, saved } = aside
  const copies = yield* copiesOf(aside, files)
  const bases = (yield* git(cwd, ['rev-parse', ...files.map((file) => `:./${file}`)]))
    .trim()
    .split('\n')

  // Creating the folder, not only finding it missing, is what claims it from a parallel run.
  yield* fs.makeDirectory(saved).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === 'AlreadyExists',
      () => leftover(saved),
    ),
  )
  yield* Effect.forEach(
    copies,
    ([file, copy]) =>
      fs
        .makeDirectory(path.dirname(copy), { recursive: true })
        .pipe(Effect.andThen(fs.copyFile(file, copy))),
    { discard: true },
  ).pipe(Effect.tapError(() => Effect.ignore(fs.remove(saved, { recursive: true }))))

  yield* Effect.forEach(argvBatches(files), (batch) => git(cwd, ['checkout', '--', ...batch]), {
    discard: true,
  }).pipe(
    Effect.tapError(() =>
      Effect.forEach(copies, ([file, copy]) => fs.copyFile(copy, file), { discard: true }).pipe(
        Effect.andThen(fs.remove(saved, { recursive: true })),
        Effect.ignore,
      ),
    ),
  )
  yield* Console.log(
    dim(`○ unstaged changes of ${listFiles(files)} set aside until the checks finish`),
  )

  return bases
})

/**
 * Puts the unstaged changes back on top of the fixes. When a fix and an unstaged change touch the
 * same or neighbouring lines, the fixes are undone on every staged file and the copies go back.
 * Never fails, since it runs as a finalizer: what it could not do is reported and returned, and
 * the copies stay in the saved folder then.
 */
const putBack = Effect.fn(function* (
  aside: Aside,
  files: ReadonlyArray<string>,
  partial: ReadonlyArray<string>,
  bases: ReadonlyArray<string>,
  before: string,
) {
  const fs = yield* FileSystem.FileSystem
  const { cwd, saved } = aside

  const result = yield* Effect.gen(function* () {
    const copies = yield* copiesOf(aside, partial)
    const merged = yield* Effect.forEach(partial, (file, index) =>
      merge(cwd, file, copies[index]![1], bases[index]!),
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
        `${red('✘')} could not put back the unstaged changes of ${listFiles(partial)}: ${reason}\n  their unstaged versions are in ${saved}, at their paths from the top of the repository: copy back what your files are missing and delete the folder`,
      ).pipe(Effect.as('stranded' as const))
    }),
  )

  if (result !== 'stranded') {
    yield* Effect.ignore(fs.remove(saved, { recursive: true }))
  }

  return result
})

/**
 * Writes to `file` its unstaged `copy` plus whatever the checks changed since the staged `base`
 * blob, or returns false when both touch the same or neighbouring lines. The merge runs on what git
 * stores, so line endings or filters a formatter rewrites are no change. `merge-file`, unlike
 * `apply --3way`, ignores the merge drivers and rerere a repository may configure.
 */
const merge = Effect.fn(function* (cwd: string, file: string, copy: string, base: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = path.join(cwd, file)
  const store = (from: string) =>
    Effect.map(git(cwd, ['hash-object', '-w', `--path=${file}`, '--', from]), (id) => id.trim())
  const checked = yield* store(target)

  if (checked === base) {
    yield* fs.copyFile(copy, target)
    return true
  }

  const temp = yield* fs.makeTempDirectory()
  const result = path.join(temp, 'result')
  const original = path.join(temp, 'base')
  const fixed = path.join(temp, 'fixed')

  return yield* Effect.gen(function* () {
    for (const [to, id] of [
      [result, yield* store(copy)],
      [original, base],
      [fixed, checked],
    ] as const) {
      yield* fs.writeFile(to, yield* gitBytes(cwd, ['cat-file', 'blob', id]))
    }

    const clean = yield* git(cwd, ['merge-file', '--quiet', result, original, fixed]).pipe(
      Effect.as(true),
      // Up to 127 is the number of conflicts; anything higher is an error.
      Effect.catchIf(
        (error) => error instanceof GitFailed && error.exitCode < 128,
        () => Effect.succeed(false),
      ),
    )

    if (clean) {
      const id = (yield* git(cwd, ['hash-object', '-w', '--no-filters', '--', result])).trim()

      yield* fs.writeFile(
        target,
        yield* gitBytes(cwd, ['cat-file', '--filters', `--path=${file}`, id]),
      )
      yield* fs.chmod(target, (yield* fs.stat(copy)).mode)
    }

    return clean
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temp, { recursive: true }))))
})
