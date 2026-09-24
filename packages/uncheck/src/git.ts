import { Buffer } from 'node:buffer'

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

  get summary(): string {
    return `${this.command} failed: ${this.stderr}`
  }
}

/**
 * Runs git in `cwd` and returns the bytes it printed. A non-zero exit fails with `GitFailed`
 * carrying stderr, where git explains itself; running outside a repository is one such failure.
 */
export const gitBytes = Effect.fn(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make('git', args, {
      cwd,
      stdin: 'ignore',
      env: {
        // Git refuses literal paths next to the other pathspec settings a user may export.
        GIT_LITERAL_PATHSPECS: '1',
        GIT_GLOB_PATHSPECS: undefined,
        GIT_ICASE_PATHSPECS: undefined,
        // A hook in a linked worktree gets GIT_DIR without GIT_WORK_TREE, which would make the
        // package folder a hook line enters the top of the repository.
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        ...env,
      },
      extendEnv: true,
    }),
  )

  const [stdout, stderr] = yield* Effect.all(
    [Stream.runCollect(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr))],
    { concurrency: 'unbounded' },
  )

  const exitCode = yield* handle.exitCode

  if (exitCode !== 0) {
    return yield* Effect.fail(new GitFailed({ args, exitCode, stderr: stderr.trim() }))
  }

  return Buffer.concat(stdout)
}, Effect.scoped)

export function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  return Effect.map(gitBytes(cwd, args, env), (output) => output.toString().replace(/\n$/, ''))
}

/** `git` for listings made with `-z`: the NUL-separated paths it printed. */
export function gitPaths(cwd: string, args: ReadonlyArray<string>) {
  return Effect.map(git(cwd, args), (output) => output.split('\0').filter((entry) => entry !== ''))
}

/**
 * The folder of `cwd` below the top of the working tree, `''` or ending in `/`, and where git keeps
 * each of `names`. Fails outside a working tree.
 */
export function gitLocation(cwd: string, names: ReadonlyArray<string> = []) {
  const args = [
    'rev-parse',
    '--is-inside-work-tree',
    '--show-prefix',
    ...names.flatMap((name) => ['--git-path', name]),
  ]

  return Effect.flatMap(git(cwd, args), (output) => {
    // A newline in the prefix shifts the lines git prints, so they are counted from both ends.
    const [inside, ...lines] = output.split('\n')
    const paths = lines.splice(lines.length - names.length)

    return inside === 'true'
      ? Effect.succeed({ prefix: lines.join('\n'), paths })
      : Effect.fail(new GitFailed({ args, exitCode: 128, stderr: 'not inside a work tree' }))
  })
}
