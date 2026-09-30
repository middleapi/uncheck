import type { Files, Layout, Project, ProjectOptions } from '../utils/project'
import { report } from '../utils/project'

export const CLEAN_CODE = 'export const home = "home";\n'

/** Fails the `no-var` rule the projects enable in oxlint. */
export const CODE_WITH_VAR = 'var count = 1;\nexport { count };\n'

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
