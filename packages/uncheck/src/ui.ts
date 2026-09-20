import type { PlatformError } from 'effect'
import process from 'node:process'
import { styleText } from 'node:util'
import { Effect, Stdio, Terminal } from 'effect'

export interface Ui {
  readonly line: (text: string) => Effect.Effect<void, PlatformError.PlatformError>
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly red: (text: string) => string
  readonly green: (text: string) => string
}

export const makeUi: Effect.Effect<Ui, never, Stdio.Stdio | Terminal.Terminal> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const terminal = yield* Terminal.Terminal
  const colors = yield* supportsColor(stdio)

  // Color support is decided here (from the Stdio service), so skip styleText's own stream check.
  const paint = (style: Parameters<typeof styleText>[0]) => (text: string) =>
    colors ? styleText(style, text, { validateStream: false }) : text

  return {
    // `display` resolves once the write completed, so a header never trails the tool output that follows it.
    line: text => terminal.display(`${text}\n`),
    bold: paint('bold'),
    dim: paint('dim'),
    red: paint('red'),
    green: paint('green'),
  }
})

function supportsColor(stdio: Stdio.Stdio): Effect.Effect<boolean> {
  if ('NO_COLOR' in process.env) {
    return Effect.succeed(false)
  }

  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
    return Effect.succeed(true)
  }

  return stdio.stdoutIsTerminal
}
