import process from 'node:process'
import { Context } from 'effect'

export type StdioMode = 'inherit' | 'pipe'

export interface UncheckOptions {
  /**
   * Directory the checks run in. Tools and `tsconfig.json` files are discovered from here.
   *
   * @default process.cwd()
   */
  readonly cwd: string
  /**
   * How tool output is handled:
   * - `inherit` streams it straight to the terminal (keeps colors and live progress).
   * - `pipe` captures it and forwards it through the `Terminal` service (useful for tests and embedding).
   *
   * @default 'inherit'
   */
  readonly stdio: StdioMode
}

export const UncheckOptions = Context.Reference<UncheckOptions>('uncheck/UncheckOptions', {
  defaultValue: () => ({ cwd: process.cwd(), stdio: 'inherit' }),
})
