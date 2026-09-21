import type { PlatformError } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import type { ProjectFiles } from './files'
import type { Bin } from './resolve'
import { Effect, FileSystem, Option, Path } from 'effect'
import { resolveBin } from './resolve'

export type StepName = 'oxlint' | 'oxfmt' | 'tsc'

export interface StepOutcome {
  readonly name: StepName
  readonly status: 'passed' | 'failed' | 'skipped'
  /** Why the step was skipped, or why it failed before any tool ran. */
  readonly reason?: string
}

export interface StepCommand {
  readonly bin: Bin
  readonly args: ReadonlyArray<string>
  /** Files appended after `args`, kept apart so the run log can summarize them. */
  readonly files?: ReadonlyArray<string>
}

/** The arguments as a short description for the run log: user-facing flags, then the files or their count. */
export function describeArgs({ args, files }: StepCommand): string {
  const shown = args.filter(arg => arg !== UNMATCHED_PATHS_OK)
  const tail = files === undefined ? [] : files.length <= 3 ? files : [`[${files.length} files]`]

  return [...shown, ...tail].join(' ')
}

export interface RunPlan {
  readonly name: StepName
  readonly status: 'run'
  readonly commands: ReadonlyArray<StepCommand>
}

/** A step that is either ready to run, or already settled without running anything. */
export type StepPlan = RunPlan | (StepOutcome & { readonly status: 'skipped' | 'failed'; readonly reason: string })

export interface StepInput {
  readonly cwd: string
  readonly fix: boolean
  /** Files to check, relative to `cwd`, or `undefined` for the whole project. */
  readonly files: ReadonlyArray<string> | undefined
  /** Whether the step was required with its flag, so it fails instead of skipping when it cannot run. */
  readonly required: boolean
  /** Every file in the project, listed once and shared between steps. */
  readonly projectFiles: ProjectFiles
}

/** One check uncheck can run. Steps live in `steps/` and are registered in `command.ts`. */
export interface Step {
  readonly name: StepName
  /** What the step does, for its flag's help text. */
  readonly does: string
  /** When the step runs by default, for its flag's help text. */
  readonly when: string
  /** Whether `--fix` applies to this step. */
  readonly fixes: boolean
  readonly plan: (
    input: StepInput,
  ) => Effect.Effect<
    StepPlan,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >
}

/** A step that cannot run: a failure when it was required, a skip otherwise. */
export function settled(name: StepName, required: boolean, reason: string): StepPlan {
  return { name, status: required ? 'failed' : 'skipped', reason }
}

/** Explicit files may include ones a tool does not handle (a Markdown file for oxlint), which is not a failure. */
const UNMATCHED_PATHS_OK = '--no-error-on-unmatched-pattern'

/** Command lines stay well below every platform's argument limit. */
const MAX_ARGS_LENGTH = 65_536

/** Splits a file list into command-line sized batches. */
export function batches(files: ReadonlyArray<string>): string[][] {
  const result: string[][] = []
  let current: string[] = []
  let length = 0

  for (const file of files) {
    if (current.length > 0 && length + file.length + 1 > MAX_ARGS_LENGTH) {
      result.push(current)
      current = []
      length = 0
    }

    current.push(file)
    length += file.length + 1
  }

  if (current.length > 0) {
    result.push(current)
  }

  return result
}

interface BinStepOptions {
  readonly name: 'oxlint' | 'oxfmt'
  readonly does: string
  readonly args: (fix: boolean) => ReadonlyArray<string>
}

/** A step that runs one installed package's bin, over the given files or the whole project. */
export function binStep({ name, does, args }: BinStepOptions): Step {
  return {
    name,
    does,
    when: `${name} is installed`,
    fixes: true,
    plan: ({ cwd, fix, files, required }) =>
      Effect.map(resolveBin(name, cwd), bin => {
        if (Option.isNone(bin)) {
          return settled(name, required, 'not installed')
        }

        const commands =
          files === undefined
            ? [{ bin: bin.value, args: args(fix) }]
            : batches(files).map(batch => ({ bin: bin.value, args: [...args(fix), UNMATCHED_PATHS_OK], files: batch }))

        return { name, status: 'run', commands }
      }),
  }
}
