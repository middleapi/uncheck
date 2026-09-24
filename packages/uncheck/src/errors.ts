import type { PlatformError } from 'effect'
import { Data, Effect } from 'effect'
import { CliError } from 'effect/unstable/cli'

import type { CheckOutcome } from './types'

export class NothingToCheck extends Data.TaggedError('NothingToCheck')<{
  readonly reason: string
}> {}

export class CannotCheck extends Data.TaggedError('CannotCheck')<{
  readonly reason: string
}> {}

export class CheckFailed extends Data.TaggedError('CheckFailed')<{
  readonly outcomes: ReadonlyArray<CheckOutcome>
}> {}

export class StopBlocked extends Data.TaggedError('StopBlocked') {}

export function userError(userMessage: string): Effect.Effect<never, CliError.UserError> {
  return Effect.fail(new CliError.UserError({ cause: new Error(userMessage), userMessage }))
}

export function platformMessage(error: PlatformError.PlatformError): string {
  return error.cause instanceof Error ? error.cause.message : error.message
}
