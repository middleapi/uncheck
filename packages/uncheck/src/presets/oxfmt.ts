import type { OxfmtConfig } from 'oxfmt'

/**
 * The oxfmt preset of the middleapi projects.
 *
 * ```ts
 * import { defineConfig } from 'oxfmt'
 * import { middleapi } from 'uncheck/oxfmt'
 *
 * export default defineConfig({ ...middleapi })
 * ```
 */
export const middleapi: OxfmtConfig = {
  semi: false,
  singleQuote: true,
  quoteProps: 'consistent',
  sortImports: true,
}
