import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'

import { Console, Effect, FileSystem, Option, Path, Predicate, Stdio, Stream } from 'effect'
import { Command, Flag } from 'effect/unstable/cli'

import { StopBlocked, userError } from '../../errors'
import { fileKind, isOutside, listChangedFiles, slashedRelative } from '../../files'
import { git, refusesRepository } from '../../git'
import { captureLines } from '../../tool'
import { fixFlag, followLinks, runChecks, selectionFlags } from '../uncheck'

export const run = Command.make(
  'run',
  {
    cwd: Flag.Directory('cwd', { mustExist: true }).pipe(
      followLinks,
      Flag.optional,
      Flag.withDescription(
        "Directory to check. Defaults to the top of the git repository around the current directory, or around the agent's project (CLAUDE_PROJECT_DIR or CODEBUDDY_PROJECT_DIR) when the current directory is outside git or in a repository nested in the project's, and to the project itself outside git",
      ),
    ),
    dir: Flag.String('dir').pipe(
      Flag.optional,
      Flag.withDescription(
        'Directory to check relative to the top of the git repository, whichever directory the agent moved to. `hooks install` writes it for a project below the top',
      ),
    ),
    fix: fixFlag.pipe(
      Flag.withDescription(
        'Apply lint fixes (oxlint --fix) and rewrite formatting (oxfmt) in the changed files. sherif only reports here: run `uncheck --fix` for its fixes',
      ),
    ),
    ...selectionFlags,
  },
  Effect.fn(function* ({ cwd: given, dir, ...settings }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stdio = yield* Stdio.Stdio

    if (yield* stdio.stdinIsTerminal) {
      return yield* userError('`uncheck hooks run` expects the agent hook payload as JSON on stdin')
    }

    const payload = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
      Effect.flatMap((text) => Effect.try((): unknown => JSON.parse(text))),
      Effect.map((value) => (Predicate.isObject(value) ? value : {})),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    )

    // Cursor also stops a turn the user interrupted, or one that failed; fixing it would edit half-done
    // work and a follow-up would restart the agent.
    if (payload.status === 'aborted' || payload.status === 'error') {
      return
    }

    const start = Option.getOrElse(given, () => process.cwd())
    const projectDir = Option.isSome(given)
      ? undefined
      : (process.env.CLAUDE_PROJECT_DIR ?? process.env.CODEBUDDY_PROJECT_DIR)
    const top = yield* topToCheck(start, projectDir)
    const cwd = Option.isSome(dir) ? path.join(top, dir.value) : Option.getOrElse(given, () => top)

    // Checking a folder that is gone would send the agent back to fix a configuration it cannot see.
    if (Option.isSome(dir) && (yield* fileKind(cwd)) !== 'Directory') {
      return yield* userError(
        `--dir=${dir.value} names no folder in ${top}, run \`uncheck hooks install\` again from the project`,
      )
    }

    // Agents also set these when another Stop hook (Claude Code's /goal is one) continued the turn, so
    // only the marker uncheck leaves when it blocks tells that it already sent the agent back.
    const continuing =
      payload.stop_hook_active === true ||
      (typeof payload.loop_count === 'number' && payload.loop_count > 0)
    const { forgetBlock, claimBlock } = stopMarker(
      fs,
      path,
      payload.session_id ?? payload.sessionId ?? payload.conversation_id,
      cwd,
    )

    if (!continuing) {
      yield* forgetBlock
    }

    const changed = yield* listChangedFiles(cwd)

    if (changed !== undefined && changed.files.length === 0 && changed.deleted.length === 0) {
      return yield* forgetBlock
    }

    const [failed, lines] = yield* runChecks(changed?.files ?? [], {
      ...settings,
      cwd,
      literal: true,
      deleted: changed?.deleted,
    }).pipe(
      Effect.map(() => false),
      Effect.catchTag('CheckFailed', () => Effect.succeed(true)),
      captureLines,
    )

    const report = stripVTControlCharacters(lines.join('\n'))

    yield* Console.error(report)

    if (!failed) {
      return yield* forgetBlock
    }

    // Send the agent back once until the checks pass again, in the way its family understands. Claude
    // Code and CodeBuddy block on exit code 2 with stderr as the message, set `stop_hook_active` once
    // they are already continuing, and show the user nothing but a `systemMessage` from a hook that
    // exits 0; Cursor continues on a follow-up message and counts them in `loop_count`; Copilot
    // continues on a block decision, also in the Claude format, where it takes exit code 2 for a mere
    // warning.
    const reason = `uncheck found problems, fix them before finishing:\n\n${report}`
    const sendBack =
      typeof (payload.stopReason ?? payload.stop_reason) === 'string'
        ? Console.log(JSON.stringify({ decision: 'block', reason }))
        : payload.hook_event_name === 'Stop'
          ? Effect.fail(new StopBlocked())
          : payload.hook_event_name === 'stop'
            ? Console.log(JSON.stringify({ followup_message: reason }))
            : undefined

    if (sendBack === undefined) {
      return
    }

    const firstBlock = yield* claimBlock

    if (continuing && !firstBlock) {
      if (payload.hook_event_name === 'Stop') {
        const summary = report
          .split('\n')
          .filter((line) => line.startsWith('✘ '))
          .at(-1)!

        yield* Console.log(
          JSON.stringify({ systemMessage: `uncheck still fails: ${summary.slice(2)}` }),
        )
      }

      return
    }

    return yield* sendBack
  }),
).pipe(
  Command.withDescription(
    'Run as an agent stop hook: check the files changed since the last commit, report on stderr and send the agent back to fix what remains',
  ),
)

function stopMarker(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sessionId: unknown,
  cwd: string,
): { readonly forgetBlock: Effect.Effect<void>; readonly claimBlock: Effect.Effect<boolean> } {
  if (typeof sessionId !== 'string') {
    return { forgetBlock: Effect.void, claimBlock: Effect.succeed(false) }
  }

  const marker = path.join(
    tmpdir(),
    `uncheck-stop-${createHash('sha256')
      .update(JSON.stringify([sessionId, path.resolve(cwd)]))
      .digest('hex')}`,
  )

  return {
    forgetBlock: Effect.ignore(fs.remove(marker, { force: true })),
    // A marker that cannot be written counts as one that exists, so a broken temporary folder never
    // sends the agent back on every stop.
    claimBlock: fs.writeFileString(marker, '', { flag: 'wx' }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  }
}

interface Repository {
  readonly top: string
  readonly commonDir: string
}

const repositoryAround = Effect.fn(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const [physicalFolder, output] = yield* Effect.all(
    [fs.realPath(folder), git(folder, ['rev-parse', '--show-toplevel', '--git-common-dir'])],
    { concurrency: 'unbounded' },
  )
  // A newline in the top shifts the lines git prints, so the common dir is counted from the end.
  const lines = output.split('\n')
  const commonDir = lines.pop()!
  const top = lines.join('\n')

  // git prints the common dir relative to the real path of `folder`, and a linked worktree may name
  // it through a link.
  const repository: Repository = {
    top,
    commonDir: yield* fs.realPath(path.resolve(physicalFolder, commonDir)),
  }

  return repository
})

// Checking a repository git refuses as if it were outside git would fix every file in the folder.
const repositoryUnlessRefused = (folder: string) =>
  repositoryAround(folder).pipe(
    Effect.catch((error) =>
      error._tag === 'GitFailed' && refusesRepository(error)
        ? userError(error.stderr)
        : Effect.succeed(undefined),
    ),
  )

const topToCheck = Effect.fn(function* (start: string, projectDir: string | undefined) {
  const path = yield* Path.Path

  const startsInProject =
    projectDir !== undefined && path.resolve(projectDir) === path.resolve(start)
  const [here, elsewhere] = yield* Effect.all(
    [
      repositoryUnlessRefused(start),
      projectDir === undefined || startsInProject
        ? Effect.succeed(undefined)
        : repositoryUnlessRefused(projectDir),
    ],
    { concurrency: 'unbounded' },
  )
  const project = startsInProject ? here : elsewhere

  if (project === undefined) {
    return here?.top ?? projectDir ?? start
  }

  if (here === undefined) {
    return project.top
  }

  // Claude Code keeps the project folder on the main checkout while the agent works in a linked
  // worktree, which shares its common dir: only a submodule or a nested clone, with a common dir of
  // its own, gives way to the project's repository above it.
  let folder = here.top
  let outer: Repository | undefined = here

  while (
    outer !== undefined &&
    outer.commonDir !== project.commonDir &&
    folder !== path.dirname(folder)
  ) {
    // A repository whose core.worktree is a subfolder names that subfolder as its top from above it
    // too, so climbing from its top alone would ask about the same folder forever.
    folder = path.dirname(
      isOutside(path, slashedRelative(path, outer.top, folder)) ? folder : outer.top,
    )
    outer = yield* repositoryAround(folder).pipe(Effect.orElseSucceed(() => undefined))
  }

  return outer?.commonDir === project.commonDir ? outer.top : here.top
})
