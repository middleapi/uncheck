// Lets Node run the TypeScript sources of uncheck as they are, so the e2e tests drive `src/bin.ts`
// itself and coverage maps onto the sources. Node strips the types; these hooks only add what the
// bundler resolves: extensionless imports, folder imports and the JSON import of package.json.

import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const SRC = new URL('../../src/', import.meta.url).href
const JSON_MODULE = '?uncheck-json'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(SRC) || !specifier.startsWith('.')) {
      return nextResolve(specifier, context)
    }

    if (specifier.endsWith('.json')) {
      return {
        url: `${new URL(specifier, context.parentURL).href}${JSON_MODULE}`,
        shortCircuit: true,
      }
    }

    const file = new URL(`${specifier}.ts`, context.parentURL)

    return nextResolve(
      existsSync(file) ? file.href : new URL(`${specifier}/index.ts`, context.parentURL).href,
      context,
    )
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(JSON_MODULE)) {
      return nextLoad(url, context)
    }

    const text = readFileSync(new URL(url.slice(0, -JSON_MODULE.length)), 'utf8')

    return { format: 'module', source: `export default ${text}`, shortCircuit: true }
  },
})
