import process from 'node:process'

import { Console, Effect, FileSystem, Path, Ref } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { userError } from '../errors'
import { existingFiles } from '../files'
import { git, gitBytes, GitFailed, gitLocation, gitPaths } from '../git'
import { dim, green, listFiles, red } from '../style'
import { argvBatches } from '../tool'
import { checkPaths, cwdFlag, fixFlag, selectionFlags, validateSelection } from './uncheck'

/** What became of the unstaged hunks that were set aside while the checks ran. */
type Unstaged = 'restored' | 'stranded' | { readonly conflicted: ReadonlyArray<string> }

export const staged = Command.make(
  'staged',
  {
    cwd: cwdFlag,
    fix: fixFlag.pipe(
      Flag.withDescription(
        'Apply lint fixes (oxlint --fix) and rewrite formatting (oxfmt) in the staged files, then stage them. sherif only reports here: run `uncheck --fix` for its fixes',
      ),
    ),
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
      const [listed, merging] = yield* Effect.all(
        [
          stagedFiles(cwd).pipe(
            Effect.catchTag('GitFailed', () =>
              userError('`uncheck staged` needs a git repository'),
            ),
          ),
          mergeInProgress(cwd),
        ],
        { concurrency: 'unbounded' },
      )
      // Fixing what a merge takes from the other side would commit changes neither side made.
      const notTheirs = merging ? new Set(yield* stagedFiles(cwd, 'MERGE_HEAD')) : undefined
      const files = notTheirs === undefined ? listed : listed.filter((file) => notTheirs.has(file))

      yield* Console.log(dim(`uncheck staged in ${cwd}`))

      if (files.length === 0) {
        const reason =
          listed.length > 0
            ? 'every staged file comes from the branch being merged in'
            : 'no staged files'

        return yield* Console.log(`${dim('○')} nothing to check, ${reason}`)
      }

      const [
        {
          prefix,
          paths: [folder = '', indexLock = ''],
        },
        unstaged,
      ] = yield* Effect.all([gitLocation(cwd, ['uncheck-unstaged', 'index.lock']), rawDiff(cwd)], {
        concurrency: 'unbounded',
      })
      const saved = path.resolve(cwd, folder)
      const aside = { cwd, saved, prefix }

      // A run that was killed, or could not put them back, left the only copy of unstaged changes.
      if (yield* fs.exists(saved)) {
        return yield* leftover(saved)
      }

      const partial = yield* partiallyStaged(unstaged, files)
      const outcome = yield* Ref.make<Unstaged>('restored')

      const { failure, empty } = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            const before = yield* writeTree(cwd)

            yield* Effect.acquireRelease(setAside(aside, partial), (copies) =>
              putBack(aside, files, copies, before).pipe(
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

          // `git add` refuses a path outside a sparse checkout even when it is on disk.
          const stage = (env?: Readonly<Record<string, string>>) =>
            gitEach(cwd, ['update-index'], changed, env)

          yield* stage()

          // `git commit <paths>` runs the hook on a temporary index, and the index it leaves
          // behind (index.lock until then) needs the fixes too, or it would hold their revert.
          const active = process.env.GIT_INDEX_FILE

          if (active?.endsWith('.lock') === true) {
            const lock = path.resolve(cwd, indexLock)

            if (path.resolve(cwd, active) !== lock && (yield* fs.exists(lock))) {
              yield* stage({ GIT_INDEX_FILE: lock })
            }
          }

          yield* Console.log(`${green('✔')} staged the fixes to ${listFiles(changed)}`)

          // git records a merge commit even when its tree is the one HEAD already has.
          if (merging) {
            return { failure, empty: false }
          }

          const [after, head] = yield* Effect.all([writeTree(cwd), headTree(cwd)], {
            concurrency: 'unbounded',
          })

          return { failure, empty: after === head }
        }),
      )

      const unstagedOutcome = yield* Ref.get(outcome)

      if (typeof unstagedOutcome === 'object') {
        return yield* userError(
          `The fixes conflict with the unstaged changes of ${listFiles(unstagedOutcome.conflicted)} and were undone. Stage the whole file, or stash its unstaged changes, then commit again.`,
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
    Effect.catchTag('GitFailed', (error) => userError(error.summary)),
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

const partiallyStaged = Effect.fn(function* (
  unstaged: Effect.Success<ReturnType<typeof rawDiff>>,
  files: ReadonlyArray<string>,
) {
  const staged = new Set(files)
  const partial: string[] = []
  const odd: string[] = []

  for (const { file, fromMode, toMode } of unstaged) {
    if (staged.has(file)) {
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

// core.safecrlf would refuse to normalize a CRLF blob git itself leaves alone, although these objects
// only feed the merge.
const STORE = ['-c', 'core.safecrlf=false', 'hash-object', '-w']

interface Aside {
  readonly cwd: string
  readonly saved: string
  readonly prefix: string
}

interface SetAside {
  readonly file: string
  readonly target: string
  readonly copy: string
  readonly base: string
}

/** Runs `git <args> -- <files>` in batches; with no files, some commands would act on every path. */
function gitEach(
  cwd: string,
  args: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  return Effect.forEach(
    files.length === 0 ? [] : argvBatches(files),
    (batch) => git(cwd, [...args, '--', ...batch], env),
    { discard: true },
  )
}

const setAside = Effect.fn(function* ({ cwd, saved, prefix }: Aside, files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const copies = files.map((file) => ({
    file,
    target: path.join(cwd, file),
    copy: path.join(saved, prefix, file),
  }))
  const restore = Effect.forEach(copies, ({ target, copy }) => fs.copyFile(copy, target), {
    discard: true,
  })

  // Creating the folder, not only finding it missing, is what claims it from a parallel run.
  yield* fs.makeDirectory(saved).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === 'AlreadyExists',
      () => leftover(saved),
    ),
  )
  yield* Effect.forEach(
    copies,
    ({ target, copy }) =>
      fs
        .makeDirectory(path.dirname(copy), { recursive: true })
        .pipe(Effect.andThen(fs.copyFile(target, copy))),
    { discard: true },
  ).pipe(Effect.tapError(() => Effect.ignore(fs.remove(saved, { recursive: true }))))

  // Plumbing, since `git checkout` runs the post-checkout hook and fails when it does. The index
  // blob is no merge base: git leaves a CRLF blob alone where hash-object normalizes it.
  const ids = yield* Effect.forEach(argvBatches(files), (batch) =>
    git(cwd, ['checkout-index', '-f', '--', ...batch]).pipe(
      Effect.andThen(git(cwd, [...STORE, '--', ...batch])),
    ),
  ).pipe(
    Effect.tapError(() =>
      restore.pipe(Effect.andThen(fs.remove(saved, { recursive: true })), Effect.ignore),
    ),
  )
  yield* Console.log(
    dim(`○ unstaged changes of ${listFiles(files)} set aside until the checks finish`),
  )

  const bases = ids.flatMap((output) => output.split('\n'))

  return copies.map((entry, index): SetAside => ({ ...entry, base: bases[index]! }))
})

/** Runs as a finalizer, so it must never fail: what it cannot do is reported and returned. */
const putBack = Effect.fn(function* (
  aside: Aside,
  files: ReadonlyArray<string>,
  copies: ReadonlyArray<SetAside>,
  before: string,
) {
  const fs = yield* FileSystem.FileSystem
  const { cwd, saved } = aside
  const partial = copies.map(({ file }) => file)

  const result = yield* Effect.gen(function* () {
    const merged = yield* Effect.forEach(copies, (entry) => merge(aside, entry), {
      concurrency: 4,
    })
    const conflicted = partial.filter((_, index) => !merged[index])

    if (conflicted.length === 0) {
      yield* Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`))
      return 'restored' as const
    }

    yield* gitEach(cwd, ['reset', '-q', before], files)
    // checkout-index fails on a file a sparse checkout leaves out, which no check could change.
    yield* gitEach(cwd, ['checkout-index', '-f'], yield* existingFiles(files, cwd))
    yield* Effect.forEach(copies, ({ target, copy }) => fs.copyFile(copy, target), {
      discard: true,
    })

    return { conflicted }
  }).pipe(
    Effect.catch((error) => {
      const reason = error instanceof GitFailed ? error.summary : String(error)

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
const merge = Effect.fn(function* ({ cwd, prefix }: Aside, { file, target, copy, base }: SetAside) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const store = (from: string) => git(cwd, [...STORE, `--path=${file}`, '--', from])
  const checked = yield* store(target)

  if (checked === base) {
    yield* fs.copyFile(copy, target)
    return true
  }

  // git keeps a CRLF blob as it is under text=auto, so merging what hash-object stores and writing it
  // back through the filters would turn every line ending of the file to LF.
  if ((yield* git(cwd, ['rev-parse', `:0:${prefix}${file}`])) !== checked) {
    return false
  }

  const temp = yield* fs.makeTempDirectory()
  const result = path.join(temp, 'result')
  const original = path.join(temp, 'base')
  const fixed = path.join(temp, 'fixed')

  return yield* Effect.gen(function* () {
    const unstaged = yield* store(copy)

    yield* Effect.forEach(
      [
        [result, unstaged],
        [original, base],
        [fixed, checked],
      ] as const,
      ([to, id]) =>
        Effect.flatMap(gitBytes(cwd, ['cat-file', 'blob', id]), (bytes) => fs.writeFile(to, bytes)),
      { concurrency: 'unbounded', discard: true },
    )

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
