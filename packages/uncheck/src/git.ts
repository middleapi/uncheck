import { Data, Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

export class GitFailed extends Data.TaggedError('GitFailed')<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {
  /** `git <args>` for messages, with the paths after `--` counted rather than listed. */
  get command(): string {
    const dash = this.args.indexOf('--')
    const shown =
      dash === -1
        ? this.args
        : [...this.args.slice(0, dash), `[${this.args.length - dash - 1} paths]`]

    return `git ${shown.join(' ')}`
  }
}

/**
 * Runs git in `cwd` and returns what it printed. A non-zero exit fails with `GitFailed` carrying
 * stderr, where git explains itself; running outside a repository is one such failure. Paths are
 * taken literally, so `app/[id]/page.ts` never also matches `app/i/page.ts`.
 */
export const git = Effect.fn(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make('git', args, {
      cwd,
      stdin: 'ignore',
      // Git refuses literal paths next to the other pathspec settings a user may export.
      env: {
        GIT_LITERAL_PATHSPECS: '1',
        GIT_GLOB_PATHSPECS: undefined,
        GIT_ICASE_PATHSPECS: undefined,
      },
      extendEnv: true,
    }),
  )

  const [stdout, stderr] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 'unbounded' },
  )

  const exitCode = yield* handle.exitCode

  if (exitCode !== 0) {
    return yield* Effect.fail(new GitFailed({ args, exitCode, stderr: stderr.trim() }))
  }

  return stdout
}, Effect.scoped)

/** `git` for listings made with `-z`: the NUL-separated paths it printed. */
export function gitPaths(cwd: string, args: ReadonlyArray<string>) {
  return Effect.map(git(cwd, args), (output) => output.split('\0').filter((entry) => entry !== ''))
}
