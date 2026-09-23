import process from 'node:process'

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

      const bases = yield* partiallyStaged(cwd, files)
      const partial = [...bases.keys()]
      const before = yield* writeTree(cwd)
      const outcome = yield* Ref.make<Unstaged>('restored')

      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            yield* Effect.acquireRelease(setAside(aside, partial), () =>
              putBack(aside, files, bases, before).pipe(
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

            // `git commit <paths>` runs the hook on a temporary index, and the index it leaves
            // behind (index.lock until then) needs the fixes too, or it would hold their revert.
            const active = process.env.GIT_INDEX_FILE

            if (active?.endsWith('.lock') === true) {
              const lock = path.resolve(
                cwd,
                (yield* git(cwd, ['rev-parse', '--git-path', 'index.lock'])).trim(),
              )

              if (path.resolve(cwd, active) !== lock && (yield* fs.exists(lock))) {
                yield* Effect.forEach(
                  argvBatches(files),
                  (batch) => git(cwd, ['add', '--', ...batch], { GIT_INDEX_FILE: lock }),
                  { discard: true },
                )
              }
            }

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

const REGULAR_FILE_MODE = /^100(?:644|755)$/

const partiallyStaged = Effect.fn(function* (cwd: string, files: ReadonlyArray<string>) {
  const entries = (yield* git(cwd, [
    'diff',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '--relative',
    '-z',
  ])).split('\0')
  const partial = new Map<string, string>()
  const odd: string[] = []

  for (let index = 0; index + 1 < entries.length; index += 2) {
    const file = entries[index + 1]!

    if (files.includes(file)) {
      const [indexMode = '', fileMode = '', indexBlob = ''] = entries[index]!.slice(1).split(' ')

      if (REGULAR_FILE_MODE.test(indexMode) && REGULAR_FILE_MODE.test(fileMode)) {
        partial.set(file, indexBlob)
      } else {
        odd.push(file)
      }
    }
  }

  if (odd.length > 0) {
    return yield* userError(
      `The unstaged changes of ${listFiles(odd)} are not edits to a file and cannot be set aside. Stage or stash them, then commit again.`,
    )
  }

  return partial
})

interface Aside {
  readonly cwd: string
  readonly saved: string
  readonly prefix: string
}

const copiesOf = Effect.fn(function* ({ cwd, saved, prefix }: Aside, files: ReadonlyArray<string>) {
  const path = yield* Path.Path

  return files.map((file) => [path.join(cwd, file), path.join(saved, prefix, file)] as const)
})

const setAside = Effect.fn(function* (aside: Aside, files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { cwd, saved } = aside
  const copies = yield* copiesOf(aside, files)

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
})

/** Runs as a finalizer, so it must never fail: what it cannot do is reported and returned. */
const putBack = Effect.fn(function* (
  aside: Aside,
  files: ReadonlyArray<string>,
  bases: ReadonlyMap<string, string>,
  before: string,
) {
  const fs = yield* FileSystem.FileSystem
  const { cwd, saved } = aside
  const partial = [...bases.keys()]

  const result = yield* Effect.gen(function* () {
    const copies = yield* copiesOf(aside, partial)
    const merged = yield* Effect.forEach(partial, (file, index) =>
      merge(cwd, file, copies[index]![1], bases.get(file)!),
    )

    if (merged.every(Boolean)) {
      yield* Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`))
      return 'restored' as const
    }

    yield* Effect.forEach(
      argvBatches(files),
      (batch) => git(cwd, ['checkout', before, '--', ...batch]),
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

// Merges what git stores: a formatter rewriting line endings would conflict with every line of a
// raw merge. `apply --3way` would run the repository's merge drivers and rerere; `merge-file` does not.
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
