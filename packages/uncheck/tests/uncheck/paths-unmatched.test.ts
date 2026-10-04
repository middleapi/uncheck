import { mkdirSync } from 'node:fs'

import { cliError, LAYOUTS, report } from '../utils/project'
import { CLEAN_CODE } from './utils'

describe.each(LAYOUTS)('uncheck with unmatched paths in a $name', ({ create, app }) => {
  it('fails before checking anything and names every path that matched no file', async () => {
    const project = create()
    mkdirSync(project.path(app, 'src/empty'))

    const { exitCode, stdout, stderr } = await project.uncheck([
      `${app}src/index.ts`,
      `${app}missing.ts`,
      `${app}src/**/*.tsx`,
      `${app}lib/`,
      `${app}src/empty`,
    ])

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck in ${project.dir}`])
    expect(stderr).toBe(
      cliError(
        `No files match ${app}missing.ts, ${app}src/**/*.tsx, ${app}lib/, ${app}src/empty. Pass --no-error-on-unmatched-pattern to run with whatever matched.`,
      ),
    )
  })

  it('fails a glob or directory whose only git entries are no files', async () => {
    const project = create({
      [`${app}legacy/old.ts`]: CLEAN_CODE,
      [`${app}shared/util.ts`]: CLEAN_CODE,
    })
      .link(`${app}links/shared`, '../shared')
      .commit()
      .write({ [`${app}legacy/old.ts`]: null })

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--only=oxlint',
      `${app}legacy/*.ts`,
      `${app}links`,
    ])

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck in ${project.dir}`])
    expect(stderr).toBe(
      cliError(
        `No files match ${app}legacy/*.ts, ${app}links. Pass --no-error-on-unmatched-pattern to run with whatever matched.`,
      ),
    )
  })

  it('checks whatever matched with --no-error-on-unmatched-pattern', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--no-error-on-unmatched-pattern',
      '--only=oxlint',
      '--only=oxfmt',
      `${app}missing.ts`,
      `${app}src/index.ts`,
      `${app}src/**/*.tsx`,
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxfmt passed',
      '○ knip skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint, oxfmt)',
    ])
  })

  it('passes with nothing to check when no path matched with --no-error-on-unmatched-pattern', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--no-error-on-unmatched-pattern',
      `${app}missing.ts`,
      `${app}src/**/*.tsx`,
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `○ nothing to check, no files match ${app}missing.ts ${app}src/**/*.tsx`,
    ])
  })
})
