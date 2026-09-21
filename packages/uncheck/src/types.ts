import type { PlatformError } from 'effect'
import type { Effect, FileSystem, Path } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import type { CannotCheck, NothingToCheck } from './errors'
import type { ProjectFiles } from './files'
import type { Bin } from './tool'

export type CheckName = 'oxlint' | 'oxfmt' | 'tsc'

export interface CheckOutcome {
  readonly name: CheckName
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly reason?: string
}

export interface CheckCommand {
  readonly bin: Bin
  readonly args: ReadonlyArray<string>
  readonly files?: ReadonlyArray<string>
}

export interface CheckInput {
  readonly cwd: string
  readonly fix: boolean
  /** Files to check, relative to `cwd`, or `undefined` for everything under it. */
  readonly files: ReadonlyArray<string> | undefined
  readonly projectFiles: ProjectFiles
}

export interface Check {
  readonly name: CheckName
  readonly fixes: boolean
  readonly plan: (
    input: CheckInput,
  ) => Effect.Effect<
    ReadonlyArray<CheckCommand>,
    NothingToCheck | CannotCheck | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >
}

export interface RunSettings {
  readonly cwd: string
  readonly fix: boolean
  readonly required: ReadonlyArray<CheckName>
  readonly skipped: ReadonlyArray<CheckName>
  readonly allowUnmatched: boolean
}
