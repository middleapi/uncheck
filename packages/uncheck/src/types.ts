import type { Effect, FileSystem, Path, PlatformError } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'

import type { CannotCheck, NothingToCheck } from './errors.ts'
import type { ProjectFiles } from './files.ts'
import type { Bin } from './tool.ts'

export type CheckName = 'sherif' | 'oxlint' | 'oxfmt' | 'tsc' | 'fallow'

export interface CheckOutcome {
  readonly name: CheckName
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly reason?: string
  readonly unrelated?: boolean
}

export interface CheckCommand {
  readonly bin: Bin
  readonly args: ReadonlyArray<string>
  readonly files?: ReadonlyArray<string>
  /** Put before each of `files`, for a tool that takes them as the values of an option. */
  readonly filePrefix?: string
  /** Runs alongside the other `parallel` commands of its check, after the rest. */
  readonly parallel?: boolean
}

export interface CheckInput {
  readonly cwd: string
  readonly fix: boolean
  /** Files to check, relative to `cwd`, or `undefined` for everything under it. */
  readonly files: ReadonlyArray<string> | undefined
  /** Files the change deletes, relative to `cwd`. Never handed to a tool, which would read `[id].ts` as a glob. */
  readonly deleted: ReadonlyArray<string>
  readonly projectFiles: ProjectFiles
}

export interface Check {
  readonly name: CheckName
  /** `workspace` fixes reach beyond the given files, so the hooks, which fix only a commit or an agent's change, leave them out. */
  readonly fixes: false | 'files' | 'workspace'
  readonly plan: (
    input: CheckInput,
  ) => Effect.Effect<
    ReadonlyArray<CheckCommand>,
    NothingToCheck | CannotCheck | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >
}
