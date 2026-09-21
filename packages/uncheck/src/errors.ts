import type { CheckOutcome } from './types'
import { Data, Effect } from 'effect'
import { CliError } from 'effect/unstable/cli'

export class NothingToCheck extends Data.TaggedError('NothingToCheck')<{
  readonly reason: string
}> {}

export class CannotCheck extends Data.TaggedError('CannotCheck')<{
  readonly reason: string
}> {}

export class CheckFailed extends Data.TaggedError('CheckFailed')<{
  readonly outcomes: ReadonlyArray<CheckOutcome>
}> {}

export class StopBlocked extends Data.TaggedError('StopBlocked')<{}> {}

export function userError(userMessage: string): Effect.Effect<never, CliError.UserError> {
  return Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
}
