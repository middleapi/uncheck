import process from 'node:process'

import { Console, Effect, FileSystem, Path, Ref } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { userError } from '../errors'
import { inNodeModules } from '../files'
import { git, gitBytes, GitFailed, gitLocation, gitPaths, rawDiff, refusesRepository } from '../git'
import { dim, green, listFiles, red } from '../style'
import { argvBatches, logLines } from '../tool'
import { checkPaths, cwdFlag, fixFlag, selectionFlags, validateSelection } from './uncheck'

/** What became of the unstaged hunks that were set aside while the checks ran. */
interface Unstaged {
  readonly conflicted: ReadonlyArray<string>
  readonly stranded: ReadonlyArray<string>
}

const RESTORED: Unstaged = { conflicted: [], stranded: [] }

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

      const {
        prefix,
        paths: [folder, indexLock],
      } = yield* gitLocation(cwd, ['uncheck-unstaged', 'index.lock']).pipe(
        Effect.catchTag('GitFailed', (error) =>
          userError(
            refusesRepository(error) ? error.stderr : '`uncheck staged` needs a git repository',
          ),
        ),
      )

      // Only regular files: tools follow a staged symlink to a file the commit does not hold.
      const [listed, merging, unstaged] = yield* Effect.all(
        [stagedFiles(cwd), mergeInProgress(cwd), rawDiff(cwd)],
        { concurrency: 'unbounded' },
      )
      // Fixing what a merge takes from the other side would commit changes neither side made.
      const theirs = merging ? yield* stagedFiles(cwd, 'MERGE_HEAD') : undefined
      const notTheirs = theirs && new Set([...theirs.files, ...theirs.deleted])
      const ours = (paths: ReadonlyArray<string>) =>
        notTheirs === undefined ? paths : paths.filter((file) => notTheirs.has(file))
      const files = ours(listed.files)
      const deleted = ours(listed.deleted)

      yield* Console.log(dim(`uncheck staged in ${cwd}`))

      if (files.length === 0 && deleted.length === 0) {
        const reason =
          listed.files.length > 0 || listed.deleted.length > 0
            ? 'every staged file comes from the branch being merged in'
            : listed.anyStaged
              ? 'only links and node_modules files are staged'
              : 'no staged files'

        return yield* Console.log(`${dim('○')} nothing to check, ${reason}`)
      }

      const saved = path.resolve(cwd, folder!)
      const aside = { cwd, saved, prefix }

      // A run that was killed, or could not put them back, left the only copy of unstaged changes.
      if (yield* fs.exists(saved)) {
        return yield* leftover(saved)
      }

      const partial = yield* partiallyStaged(unstaged, files)
      const outcome = yield* Ref.make(RESTORED)
      const fixed = yield* Ref.make<ReadonlyArray<string> | undefined>(fix ? undefined : [])
      const summary = yield* Ref.make<ReadonlyArray<string>>([])

      // `git commit <paths>` runs the hook on a temporary index, and the index it leaves
      // behind (index.lock until then) needs the fixes too, or it would hold their revert.
      const active = process.env.GIT_INDEX_FILE
      const lock = path.resolve(cwd, indexLock!)
      const lockToo = active?.endsWith('.lock') === true && path.resolve(cwd, active) !== lock

      // Staging after every check would also stage what was saved to a file while tsc ran.
      const stageFixes = Effect.gen(function* () {
        const changed = yield* differFromIndex(cwd, files)

        // `git add` refuses a path outside a sparse checkout even when it is on disk.
        yield* gitEach(cwd, ['update-index'], changed)
        yield* Ref.set(fixed, changed)

        if (lockToo && (yield* fs.exists(lock))) {
          yield* stageEntries(cwd, yield* indexEntries(cwd, changed), { GIT_INDEX_FILE: lock })
        }
      })

      const { failure, empty } = yield* Effect.scoped(
        Effect.gen(function* () {
          if (partial.length > 0) {
            const before = yield* writeTree(cwd)

            yield* Effect.acquireRelease(setAside(aside, partial), (copies) =>
              putBack(aside, files, copies, before, fixed, active).pipe(
                Effect.flatMap((result) => Ref.set(outcome, result)),
              ),
            )
          }

          const failure = yield* checkPaths(files, {
            ...selection,
            cwd,
            fix,
            literal: true,
            deleted,
            afterFixes: fix ? stageFixes : undefined,
            holdSummary: (lines) => Ref.set(summary, lines),
          }).pipe(Effect.catchTag('CheckFailed', Effect.succeed))

          const changed = yield* Ref.get(fixed)

          if (changed === undefined || changed.length === 0) {
            return { failure, empty: false }
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
      ).pipe(Effect.ensuring(Effect.flatMap(Ref.get(summary), logLines)))

      const { conflicted, stranded } = yield* Ref.get(outcome)

      if (stranded.length > 0 || conflicted.length > 0) {
        return yield* userError(
          [
            stranded.length > 0 &&
              `The unstaged changes of ${listFiles(stranded)} could not be put back, see above.`,
            conflicted.length > 0 &&
              `The fixes conflict with the unstaged changes of ${listFiles(conflicted)} and were undone. Stage the whole file, or stash its unstaged changes, then commit again.`,
          ]
            .filter(Boolean)
            .join(' '),
        )
      }

      if (empty && !allowEmpty) {
        return yield* userError(
          'The fixes undid every staged change and are staged now, so nothing new is left to commit. Commit again: git amends only the message, or refuses an empty commit. To allow empty commits, pass --allow-empty to `uncheck staged`, or to `uncheck prepare` for the hook it writes.',
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

const stagedFiles = (cwd: string, ...against: ReadonlyArray<string>) =>
  Effect.map(rawDiff(cwd, '--cached', '--diff-filter=ACMTD', ...against), (entries) => {
    const kept = entries.filter((entry) => !inNodeModules(entry.file))

    return {
      anyStaged: entries.length > 0,
      files: kept
        .filter((entry) => entry.status !== 'D' && REGULAR_FILE_MODE.test(entry.toMode))
        .map((entry) => entry.file),
      deleted: kept
        .filter((entry) => entry.status === 'D' && REGULAR_FILE_MODE.test(entry.fromMode))
        .map((entry) => entry.file),
    }
  })

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

function gitPathsEach(cwd: string, args: ReadonlyArray<string>, files: ReadonlyArray<string>) {
  return Effect.map(
    Effect.forEach(argvBatches(files), (batch) => gitPaths(cwd, [...args, '--', ...batch])),
    (batches) => batches.flat(),
  )
}

function differFromIndex(cwd: string, files: ReadonlyArray<string>) {
  return gitPathsEach(cwd, ['diff', '--name-only', '--relative', '-z'], files)
}

/** `<mode>,<id>,<path>` of each of `files` in the index, as `update-index --cacheinfo` takes it. */
function indexEntries(cwd: string, files: ReadonlyArray<string>) {
  // `--cacheinfo` reads paths from the top of the repository, wherever git runs.
  return Effect.map(
    gitPathsEach(cwd, ['ls-files', '--stage', '--full-name', '-z'], files),
    (entries) =>
      entries.map((entry) => {
        const [mode, id] = entry.split(' ')

        return `${mode},${id},${entry.slice(entry.indexOf('\t') + 1)}`
      }),
  )
}

const CACHEINFO = '--cacheinfo'

function stageEntries(
  cwd: string,
  entries: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) {
  // Each entry needs a flag of its own, which the batches have to count.
  return Effect.forEach(
    argvBatches(entries.map((entry) => `${CACHEINFO} ${entry}`)),
    (batch) =>
      git(
        cwd,
        ['update-index', ...batch.flatMap((arg) => [CACHEINFO, arg.slice(CACHEINFO.length + 1)])],
        env,
      ),
    { discard: true },
  )
}

/** Runs `git <args> -- <files>` in batches, and nothing without files. */
function gitEach(cwd: string, args: ReadonlyArray<string>, files: ReadonlyArray<string>) {
  return Effect.forEach(argvBatches(files), (batch) => git(cwd, [...args, '--', ...batch]), {
    discard: true,
  })
}

function copyBack(entries: ReadonlyArray<{ readonly target: string; readonly copy: string }>) {
  return FileSystem.FileSystem.use((fs) =>
    Effect.forEach(entries, ({ target, copy }) => fs.copyFile(copy, target), { discard: true }),
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
      copyBack(copies).pipe(Effect.andThen(fs.remove(saved, { recursive: true })), Effect.ignore),
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
  fixed: Ref.Ref<ReadonlyArray<string> | undefined>,
  index: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const { cwd, saved } = aside
  const partial = copies.map(({ file }) => file)
  const restored = Console.log(dim(`○ unstaged changes of ${listFiles(partial)} restored`)).pipe(
    Effect.as(RESTORED),
  )
  const strand = (stranded: ReadonlyArray<string>, reason: string) =>
    Console.log(
      `${red('✘')} could not put back the unstaged changes of ${listFiles(stranded)}: ${reason}\n  their unstaged versions are in ${saved}, at their paths from the top of the repository: copy back what your files are missing and delete the folder`,
    )

  const result = yield* Effect.gen(function* () {
    // Killed by Ctrl-C, git deletes the lock index it ran the hook on, as with `git commit -i`: no staged
    // version is left to merge with, and writing that index would leave a stale lock behind.
    if (index?.endsWith('.lock') === true && !(yield* fs.exists(index))) {
      yield* copyBack(copies)
      return yield* restored
    }

    const stagedFixes = yield* Ref.get(fixed)
    const merged = yield* Effect.forEach(
      copies,
      (entry) =>
        Effect.map(merge(aside, entry, before, stagedFixes !== undefined), (outcome) => ({
          ...entry,
          ...outcome,
        })),
      { concurrency: 4 },
    )
    const conflicted = merged.filter(({ clean }) => !clean)

    if (conflicted.length === 0) {
      return yield* restored
    }

    const isPartial = new Set(partial)
    const fixedInFull = (stagedFixes ?? []).filter((file) => !isPartial.has(file))
    // A file saved since its fixes were staged holds an edit made during the run, which a
    // checkout or its unstaged copy would throw away.
    const editedSince = new Set(yield* differFromIndex(cwd, fixedInFull))

    yield* gitEach(cwd, ['reset', '-q', before], files)
    yield* gitEach(
      cwd,
      ['checkout-index', '-f'],
      fixedInFull.filter((file) => !editedSince.has(file)),
    )
    yield* copyBack(merged.filter(({ edited }) => !edited))

    const stranded = conflicted.filter(({ edited }) => edited)

    if (stranded.length > 0) {
      // A copy left beside the stranded ones would invite copying it over a newer file.
      yield* Effect.forEach(
        merged.filter((entry) => !stranded.includes(entry)),
        ({ copy }) => fs.remove(copy),
        { discard: true },
      )
      yield* strand(
        stranded.map(({ file }) => file),
        'they conflict with edits saved while the checks ran',
      )
    }

    return {
      conflicted: conflicted.filter(({ edited }) => !edited).map(({ file }) => file),
      stranded: stranded.map(({ file }) => file),
    }
  }).pipe(
    Effect.catch((error) =>
      strand(partial, error instanceof GitFailed ? error.summary : String(error)).pipe(
        Effect.as({ conflicted: [], stranded: partial }),
      ),
    ),
  )

  if (result.stranded.length === 0) {
    yield* Effect.ignore(fs.remove(saved, { recursive: true }))
  }

  return result
})

// Merges what git stores: a formatter rewriting line endings would conflict with every line of a
// raw merge. `apply --3way` would run the repository's merge drivers and rerere; `merge-file` does not.
const merge = Effect.fn(function* (
  { cwd, prefix }: Aside,
  { file, target, copy, base }: SetAside,
  before: string,
  fixesStaged: boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const store = (from: string) => git(cwd, [...STORE, `--path=${file}`, '--', from])
  const checked = yield* store(target)

  if (checked === base) {
    yield* fs.copyFile(copy, target)
    return { clean: true, edited: false }
  }

  const [staged, stored] = (yield* git(cwd, [
    'rev-parse',
    `:0:${prefix}${file}`,
    `${before}:${prefix}${file}`,
  ])).split('\n')
  // Until the fixes are staged, a fixed file differs from the index just as an edited one does.
  // hash-object turns the CRLF of a blob git keeps that way to LF, so only git can tell whether the
  // file still holds what is staged.
  const edited =
    fixesStaged && staged !== checked && (yield* differFromIndex(cwd, [file])).length > 0

  // git keeps a CRLF blob as it is under text=auto, so merging what hash-object stores and writing it
  // back through the filters would turn every line ending of the file to LF.
  if (stored !== base && staged !== checked) {
    return { clean: false, edited }
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

    return { clean, edited }
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temp, { recursive: true }))))
})
