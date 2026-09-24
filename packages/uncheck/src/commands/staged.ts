import process from 'node:process'

import { Console, Effect, FileSystem, Path, Ref } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { userError } from '../errors'
import { existingFiles } from '../files'
import { git, gitBytes, GitFailed, gitPaths } from '../git'
import { dim, green, listFiles, red } from '../style'
import { argvBatches } from '../tool'
import { checkPaths, cwdFlag, fixFlag, selectionFlags, validateSelection } from './uncheck'

/** What became of the unstaged hunks that were set aside while the checks ran. */
type Unstaged = 'restored' | 'conflicted' | 'stranded'

export const staged = Command.make(
  'staged',
  {
    cwd: cwdFlag,
    fix: fixFlag,
    allowEmpty: Flag.Boolean('allow-empty').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'Let the commit through when the fixes undo every staged change, which makes it empty',
      ),
    ),
    ...selectionFlags,
  },
  Effect.fn(
    function* ({ cwd: directory, fix, allowEmpty, ...selection }) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* validateSelection(selection)

      const cwd = path.resolve(directory)

      // Only regular files: tools follow a staged symlink to a file the commit does not hold.
      const listed = yield* stagedFiles(cwd).pipe(
        Effect.catchTag('GitFailed', () => userError('`uncheck staged` needs a git repository')),
      )
      const merging = yield* mergeInProgress(cwd)
      // Fixing what a merge takes from the other side would commit changes neither side made.
      const notTheirs = merging ? new Set(yield* stagedFiles(cwd, 'MERGE_HEAD')) : undefined
      const files = notTheirs === undefined ? listed : listed.filter((file) => notTheirs.has(file))

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

      const partial = yield* partiallyStaged(cwd, files)
      const before = yield* writeTree(cwd)
      const outcome = yield* Ref.make<Unstaged>('restored')

      const { failure, empty } = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            yield* Effect.acquireRelease(setAside(aside, partial), (bases) =>
              putBack(aside, files, bases, before).pipe(
                Effect.flatMap((result) => Ref.set(outcome, result)),
              ),
            )
          }

          const failure = yield* checkPaths(files, {
            ...selection,
            cwd,
            fix,
            literal: true,
            staged: true,
          }).pipe(Effect.catchTag('CheckFailed', Effect.succeed))

          if (!fix) {
            return { failure, empty: false }
          }

          const changed = (yield* Effect.forEach(argvBatches(files), (batch) =>
            gitPaths(cwd, ['diff', '--name-only', '--relative', '-z', '--', ...batch]),
          )).flat()

          if (changed.length === 0) {
            return { failure, empty: false }
          }

          const stage = (env?: Readonly<Record<string, string>>) =>
            Effect.forEach(
              argvBatches(changed),
              (batch) => git(cwd, ['add', '--', ...batch], env),
              { discard: true },
            )

          yield* stage()

          // `git commit <paths>` runs the hook on a temporary index, and the index it leaves
          // behind (index.lock until then) needs the fixes too, or it would hold their revert.
          const active = process.env.GIT_INDEX_FILE

          if (active?.endsWith('.lock') === true) {
            const lock = path.resolve(
              cwd,
              yield* git(cwd, ['rev-parse', '--git-path', 'index.lock']),
            )

            if (path.resolve(cwd, active) !== lock && (yield* fs.exists(lock))) {
              yield* stage({ GIT_INDEX_FILE: lock })
            }
          }

          yield* Console.log(`${green('✔')} staged the fixes to ${listFiles(changed)}`)

          // git records a merge commit even when its tree is the one HEAD already has.
          return { failure, empty: !merging && (yield* writeTree(cwd)) === (yield* headTree(cwd)) }
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

      if (empty && !allowEmpty) {
        return yield* userError(
          'The fixes undid every staged change, so the commit would be empty. To allow empty commits, pass --allow-empty to `uncheck staged`, or to `uncheck prepare` for the hook it writes.',
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

const writeTree = (cwd: string) => git(cwd, ['write-tree'])

const headTree = (cwd: string) =>
  git(cwd, ['rev-parse', '-q', '--verify', 'HEAD^{tree}']).pipe(
    Effect.catchTag('GitFailed', () => Effect.succeed(undefined)),
  )

const mergeInProgress = (cwd: string) =>
  git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).pipe(
    Effect.as(true),
    Effect.catchTag('GitFailed', () => Effect.succeed(false)),
  )

const leftover = (saved: string) =>
  userError(
    `An earlier run left the unstaged versions of your files in ${saved}, at their paths from the top of the repository. Unless another commit is running, copy back what your files are missing, delete the folder, then commit again.`,
  )

const REGULAR_FILE_MODE = /^100(?:644|755)$/

const rawDiff = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.map(
    git(cwd, [
      'diff',
      '--raw',
      '--no-renames',
      '--ignore-submodules=all',
      '--relative',
      '-z',
      ...args,
    ]),
    (output) => {
      const fields = output.split('\0')

      return Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => {
        const [fromMode = '', toMode = ''] = fields[index * 2]!.slice(1).split(' ')

        return { file: fields[index * 2 + 1]!, fromMode, toMode }
      })
    },
  )

const stagedFiles = (cwd: string, ...against: ReadonlyArray<string>) =>
  Effect.map(rawDiff(cwd, '--cached', '--diff-filter=ACMT', ...against), (entries) =>
    entries.filter((entry) => REGULAR_FILE_MODE.test(entry.toMode)).map((entry) => entry.file),
  )

const partiallyStaged = Effect.fn(function* (cwd: string, files: ReadonlyArray<string>) {
  const partial: string[] = []
  const odd: string[] = []

  for (const { file, fromMode, toMode } of yield* rawDiff(cwd)) {
    if (files.includes(file)) {
      if (REGULAR_FILE_MODE.test(fromMode) && REGULAR_FILE_MODE.test(toMode)) {
        partial.push(file)
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

  // Plumbing, since `git checkout` runs the post-checkout hook and fails when it does. The index
  // blob is no merge base: git leaves a CRLF blob alone where hash-object normalizes it.
  const ids = yield* Effect.forEach(argvBatches(files), (batch) =>
    git(cwd, ['checkout-index', '-f', '--', ...batch]).pipe(
      Effect.andThen(git(cwd, ['hash-object', '-w', '--', ...batch])),
    ),
  ).pipe(
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

  return new Map(
    ids.flatMap((output) => output.split('\n')).map((id, index) => [files[index]!, id]),
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
      merge(aside, file, copies[index]![1], bases.get(file)!),
    )

    if (merged.every(Boolean)) {
      yield* Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`))
      return 'restored' as const
    }

    yield* Effect.forEach(
      argvBatches(files),
      (batch) => git(cwd, ['reset', '-q', before, '--', ...batch]),
      { discard: true },
    )
    // checkout-index fails on a file a sparse checkout leaves out, which no check could change.
    yield* Effect.forEach(
      argvBatches(yield* existingFiles(files, cwd)),
      (batch) => git(cwd, ['checkout-index', '-f', '--', ...batch]),
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
const merge = Effect.fn(function* (
  { cwd, prefix }: Aside,
  file: string,
  copy: string,
  base: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = path.join(cwd, file)
  const store = (from: string) => git(cwd, ['hash-object', '-w', `--path=${file}`, '--', from])
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
      const id = yield* git(cwd, ['hash-object', '-w', '--no-filters', '--', result])

      // Unlike hash-object, cat-file takes --path from the top of the repository.
      yield* fs.writeFile(
        target,
        yield* gitBytes(cwd, ['cat-file', '--filters', `--path=${prefix}${file}`, id]),
      )
      yield* fs.chmod(target, (yield* fs.stat(copy)).mode)
    }

    return clean
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temp, { recursive: true }))))
})
