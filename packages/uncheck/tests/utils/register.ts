import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// The sources import without extensions and read package.json without attributes, which only the
// bundler understands.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]s|json)$/.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context)
        } catch {}
      }
    }

    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.json') && context.importAttributes.type === undefined) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${readFileSync(fileURLToPath(url), 'utf8')}`,
      }
    }

    return nextLoad(url, context)
  },
})
