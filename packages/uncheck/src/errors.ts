import type { CheckOutcome } from './types'
import { Data } from 'effect'

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
