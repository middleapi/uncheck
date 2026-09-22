import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOOLS = ['sherif', 'oxlint', 'oxfmt', 'typescript'] as const

const packageNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url))
const fixtures: string[] = []

afterAll(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Creates a throwaway project in the OS temp dir. Objects are written as JSON, the requested tools
 * are symlinked into `node_modules` so they resolve like a regular install, and config files are
 * kept out of the format check so tests only see the formatting issues they put in.
 */
export function fixture(
  files: Record<string, string | object>,
  tools: ReadonlyArray<(typeof TOOLS)[number]> = TOOLS,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'uncheck-'))
  fixtures.push(dir)

  if (tools.length > 0) {
    mkdirSync(join(dir, 'node_modules'))

    for (const tool of tools) {
      symlinkSync(realpathSync(join(packageNodeModules, tool)), join(dir, 'node_modules', tool))
    }
  }

  const defaults = {
    '.gitignore': 'node_modules\ndist\n',
    '.prettierignore': 'tsconfig.json\n.oxlintrc.json\n',
  }

  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true })
    writeFileSync(join(dir, relative), typeof content === 'string' ? content : JSON.stringify(content))
  }

  return dir
}
