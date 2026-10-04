import { mkdirSync } from 'node:fs'

import {
  monorepo,
  report,
  singleRepo,
  SKIPPED_FOR_DELETIONS,
  UTILS_NOT_FOUND,
} from '../utils/project'

describe('uncheck staged with deleted files in a single repo', () => {
  it('typechecks the project a staged deletion breaks', async () => {
    const project = singleRepo()

    project.git('rm', '--quiet', '--', 'src/utils.ts')

    const { exitCode, stdout } = await project.uncheck(['staged'])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      ...SKIPPED_FOR_DELETIONS,
      '○ knip skipped, not installed',
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
      '○ knip skipped, not installed',
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 3 checks failed: tsc',
    ])
    expect(stdout).toContain(UTILS_NOT_FOUND)
    expect(exitCode).toBe(1)
  })

  it.each([[[]], [['--require=oxlint', '--require=oxfmt']]])(
    'passes a staged deletion nothing imports, with %j',
    async (flags) => {
      const project = singleRepo({ 'src/unused.ts': 'export const unused = 1;\n' })

      project.git('rm', '--quiet', '--', 'src/unused.ts')

      const { exitCode, stdout } = await project.uncheck(['staged', ...flags])

      expect(report(stdout)).toEqual([
        `uncheck staged in ${project.dir}`,
        ...SKIPPED_FOR_DELETIONS,
        '○ knip skipped, not installed',
        '▶ tsc -p tsconfig.json --noEmit',
        '✔ tsc passed',
        '✔ all checks passed (tsc)',
      ])
      expect(exitCode).toBe(0)
    },
  )

  it('passes a staged deletion no check covers with oxlint and oxfmt required', async () => {
    const project = singleRepo({ 'NOTES.md': '# Notes\n' })

    project.git('rm', '--quiet', '--', 'NOTES.md')

    const { exitCode, stdout } = await project.uncheck([
      'staged',
      '--only=oxlint',
      '--only=oxfmt',
      '--require=oxlint',
      '--require=oxfmt',
    ])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, only deleted files',
      '○ oxfmt skipped, only deleted files',
      '○ knip skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '○ nothing to check: sherif not selected by --only, oxlint only deleted files, oxfmt only deleted files, knip not selected by --only, tsc not selected by --only',
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
      '○ knip skipped, not installed',
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(exitCode).toBe(0)
    expect(project.read('src/legacy.ts')).toBe(legacy)
    expect(project.git('status', '--porcelain')).toBe('D  src/legacy.ts\n?? src/legacy.ts\n')
  })
})

describe('uncheck staged with deleted files in a monorepo', () => {
  it('builds the projects that reference a deleted tsconfig.json', async () => {
    const project = monorepo()

    project.git('rm', '--quiet', '--', 'packages/core/tsconfig.json')

    const { exitCode, stdout } = await project.uncheck(['staged'])

    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      ...SKIPPED_FOR_DELETIONS,
      '○ knip skipped, not installed',
      '▶ tsc -b tsconfig.json',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(project.normalize(stdout)).toContain(
      "error TS6053: File '<project>/packages/core/tsconfig.json' not found.",
    )
    expect(exitCode).toBe(1)
  })
})
