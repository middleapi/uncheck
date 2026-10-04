import { join } from 'node:path'

import type { Files, Layout, Project, ProjectOptions } from '../utils/project'
import { monorepo, report } from '../utils/project'

export const CLEAN_CODE = 'export const home = "home";\n'

/** Fails the `no-var` rule the projects enable in oxlint. */
export const CODE_WITH_VAR = 'var count = 1;\nexport { count };\n'

export const UNFORMATTED_CODE = 'export const   ugly = {a:1,\n b:2}\n'

export const CODE_WITH_TYPE_ERROR = 'export const broken: number = "42";\n'

export interface LayoutChecks {
  readonly sherif: ReadonlyArray<string>
  readonly checks: ReadonlyArray<string>
}

export function layoutChecks(app: string, { fix = false } = {}): LayoutChecks {
  return app === ''
    ? { sherif: ['○ sherif skipped, not a workspace root'], checks: ['oxlint', 'oxfmt', 'tsc'] }
    : {
        sherif: [fix ? '▶ sherif --fix --select=highest' : '▶ sherif', '✔ sherif passed'],
        checks: ['sherif', 'oxlint', 'oxfmt', 'tsc'],
      }
}

export function monorepoWithMismatchedVersions(sherif: object = {}): Project {
  // Without noInstall, sherif --fix runs the package manager to install the versions it aligned.
  return monorepo()
    .update('package.json', (manifest) => ({ ...manifest, sherif: { noInstall: true, ...sherif } }))
    .update('packages/core/package.json', (manifest) => ({
      ...manifest,
      dependencies: { zod: '^3.0.0' },
    }))
    .update('packages/app/package.json', (manifest) => ({
      ...manifest,
      dependencies: { '@repo/core': 'workspace:*', 'zod': '^3.1.0' },
    }))
}

const LISTING_OXLINT = [
  'for (const arg of process.argv.slice(2)) {',
  "  if (!arg.startsWith('--')) console.log('checked ' + arg)",
  '}',
  '',
].join('\n')

/** A project whose oxlint passes and prints each file it gets, to see every file of a long list. */
export function listingProject(
  create: Layout['create'],
  files?: Files,
  options?: ProjectOptions,
): Project {
  return create(files, { ...options, tools: [] }).fake('oxlint', LISTING_OXLINT)
}

/** The files the oxlint of `listingProject` printed, in the order it got them. */
export function checkedFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('checked '))
    .map((line) => line.slice('checked '.length))
}

/** The report without the checks that `--only` leaves out. */
export function selectedReport(stdout: string): string[] {
  return report(stdout).filter((line) => !line.endsWith(' skipped, not selected by --only'))
}

export const NOT_COVERED = '○ tsc skipped, no tsconfig.json covers the given files'

const FALLOW_NOT_SELECTED = '○ fallow skipped, not selected by --only'

export const SKIPPED_BESIDE_TSC = [
  '○ sherif skipped, not selected by --only',
  '○ oxlint skipped, not selected by --only',
  '○ oxfmt skipped, not selected by --only',
]

export function tscOnlyReport(
  heading: string,
  plan: ReadonlyArray<string>,
  outcome: 'passed' | 'failed',
): string[] {
  return [
    heading,
    ...SKIPPED_BESIDE_TSC,
    ...plan,
    ...(outcome === 'passed'
      ? ['✔ tsc passed', FALLOW_NOT_SELECTED, '✔ all checks passed (tsc)']
      : ['✘ tsc failed', FALLOW_NOT_SELECTED, '✘ 1 of 1 checks failed: tsc']),
  ]
}

// oxlint-disable-next-line no-template-curly-in-string
export const CONFIG_DIR = '${configDir}'

export const ALLOW_JS = { compilerOptions: { allowJs: true } }

/** Without it, the members of a references graph are checked with `-p` instead of built with `-b`. */
export const OUT_DIR = { compilerOptions: { outDir: 'dist' } }

export const NO_EMIT = { compilerOptions: { noEmit: true } }

export function withFakeTsc(
  create: Layout['create'],
  files?: Files,
  options?: ProjectOptions,
): Project {
  return create(files, { ...options, tools: [] }).fake('typescript', '')
}

/** The tsc lines of a `--only=tsc` run on `paths`, which it first creates when missing. */
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
