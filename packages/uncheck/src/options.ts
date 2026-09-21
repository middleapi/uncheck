import process from 'node:process'
import { Context } from 'effect'

export interface UncheckOptions {
  /**
   * Directory the checks run in. Tools and `tsconfig.json` files are discovered from here.
   *
   * @default process.cwd()
   */
  readonly cwd: string
}

export const UncheckOptions = Context.Reference<UncheckOptions>('uncheck/UncheckOptions', {
  defaultValue: () => ({ cwd: process.cwd() }),
})
