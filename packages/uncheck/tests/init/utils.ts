import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import process from 'node:process'

import type { Files, Project } from '../utils/project'
import { environment, project, temporaryDirectory } from '../utils/project'

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const

export const SCRIPTS = {
  check: 'uncheck',
  fix: 'uncheck --fix',
  prepare: 'uncheck prepare --pre-commit',
}

const FAKE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [log, name, ...args] = process.argv.slice(2)

appendFileSync(log, \`\${[name, ...args].join(' ')}\\n\`)

if (process.env.FAKE_INSTALL_FAILS !== undefined) {
  console.error(\`\${name}: install failed\`)
  process.exit(1)
}

const text = readFileSync('package.json', 'utf8')
const manifest = JSON.parse(text)
const added = args.filter((arg) => !arg.startsWith('-') && arg !== 'add' && arg !== 'install')

manifest.devDependencies = {
  ...manifest.devDependencies,
  ...Object.fromEntries(added.map((name) => [name, '^1.0.0'])),
}
writeFileSync(
  'package.json',
  \`\${JSON.stringify(manifest, null, /^[ \\t]+(?=")/m.exec(text)?.[0] ?? 2)}\\n\`,
)
console.log(\`\${name} added \${added.join(' ')}\`)
`

export function fakePackageManagers() {
  const dir = temporaryDirectory()
  const log = join(dir, 'calls.log')
  const script = join(dir, 'fake.mjs')

  writeFileSync(script, FAKE)

  for (const name of PACKAGE_MANAGERS) {
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\nexec '${process.execPath}' '${script}' '${log}' ${name} "$@"\n`,
      { mode: 0o755 },
    )
  }

  return {
    env: { PATH: `${dir}${delimiter}${environment().PATH}` },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(0, -1) : []),
  }
}

export function manifest(fields: object = {}): Files {
  return {
    'package.json': { name: 'app', version: '1.0.0', private: true, type: 'module', ...fields },
  }
}

export function bareProject(files: Files = {}): Project {
  return project(
    { ...manifest(), 'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n', ...files },
    { tools: [] },
  ).write({ 'node_modules/uncheck': null, 'node_modules/.bin/uncheck': null })
}

export function manifestOf(project: Project): Record<string, unknown> {
  return JSON.parse(project.read('package.json')) as Record<string, unknown>
}

export function initOutput(lines: ReadonlyArray<string>, packageManager = 'pnpm'): string {
  return `${lines.map((line) => `${line}\n`).join('')}\nRun ${packageManager} run check to check the project, and ${packageManager} run fix to fix what can be fixed.\n`
}
