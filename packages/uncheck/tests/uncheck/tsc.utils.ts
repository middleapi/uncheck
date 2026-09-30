import { join } from 'node:path'

import type { Files, Layout, Project, ProjectOptions } from '../utils/project'
import { report } from '../utils/project'

export const NOT_COVERED = '○ tsc skipped, no tsconfig.json covers the given files'

export const SKIPPED_BY_ONLY = [
  '○ sherif skipped, not selected by --only',
  '○ oxlint skipped, not selected by --only',
  '○ oxfmt skipped, not selected by --only',
]

// oxlint-disable-next-line no-template-curly-in-string
export const CONFIG_DIR = '${configDir}'

export const ALLOW_JS = { compilerOptions: { allowJs: true } }

export function withFakeTsc(
  create: Layout['create'],
  files?: Files,
  options?: ProjectOptions,
): Project {
  return create(files, { ...options, tools: [] }).fake('typescript', '')
}

export async function tscPlan(
  project: Project,
  cwd: string,
  paths: ReadonlyArray<string> = [],
): Promise<string[]> {
  const missing = paths.map((file) => join(cwd, file)).filter((file) => !project.exists(file))

  project.write(Object.fromEntries(missing.map((file) => [file, ''])))

  const { exitCode, stdout } = await project.uncheck(['--only=tsc', ...paths], { cwd })
  const plan = report(stdout).filter((line) => /^[▶○✘] tsc /.test(line))

  expect(exitCode).toBe(plan.length > 0 && plan.every((line) => line.startsWith('▶')) ? 0 : 1)

  return plan
}
