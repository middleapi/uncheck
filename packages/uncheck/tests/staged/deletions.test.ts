import { mkdirSync } from 'node:fs'

import { report, singleRepo } from '../utils/project'
import { UTILS_NOT_FOUND } from './utils'

const SKIPPED_FOR_DELETIONS = [
  '○ sherif skipped, no package.json among the given files',
  '○ oxlint skipped, only deleted files',
  '○ oxfmt skipped, only deleted files',
]

describe('uncheck staged with deleted files in a single repo', () => {
  it('typechecks the project a staged deletion breaks', async () => {
    const project = singleRepo()

    project.git('rm', '--quiet', '--', 'src/utils.ts')

    const { exitCode, stdout } = await project.uncheck(['staged'])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      ...SKIPPED_FOR_DELETIONS,
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(stdout).toContain(UTILS_NOT_FOUND)
    expect(exitCode).toBe(1)
  })

  it('typechecks the project a file moves out of', async () => {
    const project = singleRepo()

    mkdirSync(project.path('scripts'))
    project.git('mv', 'src/utils.ts', 'scripts/utils.ts')

    const { exitCode, stdout } = await project.uncheck(['staged'])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --no-error-on-unmatched-pattern scripts/utils.ts',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern scripts/utils.ts',
      '✔ oxfmt passed',
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 3 checks failed: tsc',
    ])
    expect(stdout).toContain(UTILS_NOT_FOUND)
    expect(exitCode).toBe(1)
  })

  it('passes a staged deletion nothing imports', async () => {
    const project = singleRepo({ 'src/unused.ts': 'export const unused = 1;\n' })

    project.git('rm', '--quiet', '--', 'src/unused.ts')

    const { exitCode, stdout } = await project.uncheck(['staged'])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      ...SKIPPED_FOR_DELETIONS,
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(exitCode).toBe(0)
  })

  it('never fixes or stages a file only removed from the index', async () => {
    const legacy = 'export const   legacy = 1\n'
    const project = singleRepo({ 'src/legacy.ts': legacy })

    project.git('rm', '--quiet', '--cached', '--', 'src/legacy.ts')

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix'])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      ...SKIPPED_FOR_DELETIONS,
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(exitCode).toBe(0)
    expect(project.read('src/legacy.ts')).toBe(legacy)
    expect(project.git('status', '--porcelain')).toBe('D  src/legacy.ts\n?? src/legacy.ts\n')
  })
})
