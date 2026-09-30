import { mkdirSync } from 'node:fs'

import { LAYOUTS, report } from '../utils/project'
import { selectedReport } from './paths-utils'

describe.each(LAYOUTS)('uncheck with unmatched paths in a $name', ({ create, app }) => {
  it('fails before checking anything and names every path that matched no file', async () => {
    const project = create()
    mkdirSync(project.path(app, 'src/empty'))

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--only=oxlint',
      `${app}src/index.ts`,
      `${app}missing.ts`,
      `${app}src/**/*.tsx`,
      `${app}lib/`,
      `${app}src/empty`,
    ])

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck in ${project.dir}`])
    expect(stderr).toBe(
      `\nERROR\n  No files match ${app}missing.ts, ${app}src/**/*.tsx, ${app}lib/, ${app}src/empty. Pass --no-error-on-unmatched-pattern to run with whatever matched.\n`,
    )
  })

  it('checks whatever matched with --no-error-on-unmatched-pattern', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--only=oxlint',
      '--no-error-on-unmatched-pattern',
      `${app}missing.ts`,
      `${app}src/index.ts`,
      `${app}src/**/*.tsx`,
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
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
