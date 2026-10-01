import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cliError, LAYOUTS, temporaryDirectory } from '../utils/project'
import { CLEAN_CODE, CODE_WITH_VAR, selectedReport } from './utils'

describe.each(LAYOUTS)('uncheck with paths in the git repository of a $name', ({ create, app }) => {
  const routes = `${app}src/routes`

  it('leaves files git ignores out of a directory or glob but checks one named', async () => {
    const project = create({
      [`${routes}/home.ts`]: CLEAN_CODE,
      [`${routes}/dist/bundle.ts`]: CODE_WITH_VAR,
    })

    const directory = await project.uncheck(['--only=oxlint', routes])
    const glob = await project.uncheck(['--only=oxlint', `${routes}/**/*.ts`])
    const ignoredDirectory = await project.uncheck(['--only=oxlint', `${routes}/dist`])
    const named = await project.uncheck(['--only=oxlint', `${routes}/dist/bundle.ts`])

    for (const { exitCode, stdout } of [directory, glob]) {
      expect(exitCode).toBe(0)
      expect(selectedReport(stdout)).toEqual([
        `uncheck in ${project.dir}`,
        `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
        '✔ oxlint passed',
        '✔ all checks passed (oxlint)',
      ])
    }
    expect(ignoredDirectory.exitCode).toBe(1)
    expect(ignoredDirectory.stderr).toBe(
      cliError(
        `No files match ${routes}/dist. Pass --no-error-on-unmatched-pattern to run with whatever matched.`,
      ),
    )
    expect(named.exitCode).toBe(1)
    expect(selectedReport(named.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/dist/bundle.ts`,
      '✘ oxlint failed',
      '✘ 1 of 1 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
  })

  it('checks untracked files', async () => {
    const project = create({ [`${routes}/home.ts`]: CLEAN_CODE })
    project.write({ [`${routes}/fresh.ts`]: CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', routes])

    expect(exitCode).toBe(1)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/fresh.ts ${routes}/home.ts`,
      '✘ oxlint failed',
      '✘ 1 of 1 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
  })

  it('checks the files of a repository without commits', async () => {
    const project = create({ [`${routes}/home.ts`]: CLEAN_CODE }, { git: 'init' })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', routes])

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('drops a tracked file deleted from the working tree before it is staged', async () => {
    const project = create({
      [`${routes}/home.ts`]: CLEAN_CODE,
      [`${routes}/gone.ts`]: CLEAN_CODE,
    })
    project.write({ [`${routes}/gone.ts`]: null })

    const directory = await project.uncheck(['--only=oxlint', routes])
    const glob = await project.uncheck(['--only=oxlint', `${routes}/*.ts`])

    for (const { exitCode, stdout } of [directory, glob]) {
      expect(exitCode).toBe(0)
      expect(selectedReport(stdout)).toEqual([
        `uncheck in ${project.dir}`,
        `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
        '✔ oxlint passed',
        '✔ all checks passed (oxlint)',
      ])
    }
  })

  it('hands the tools a linked folder as the file git lists, so oxlint checks its files twice', async () => {
    const project = create({ [`${routes}/shared/util.ts`]: CODE_WITH_VAR })
      .link(`${routes}/linked`, 'shared')
      .commit()

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', routes])

    expect(exitCode).toBe(1)
    expect(stdout).toContain(`${routes}/linked/util.ts:1:1`)
    expect(stdout).toContain(`${routes}/shared/util.ts:1:1`)
    expect(stdout).toContain('eslint(no-var)')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/linked ${routes}/shared/util.ts`,
      '✘ oxlint failed',
      '✘ 1 of 1 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
  })

  it('leaves out a linked node_modules that a folder-only ignore rule misses', async () => {
    const store = temporaryDirectory()
    writeFileSync(join(store, 'index.ts'), CODE_WITH_VAR)
    const project = create({
      '.gitignore': 'node_modules/\ndist/\n',
      [`${routes}/home.ts`]: CLEAN_CODE,
    }).link(`${routes}/node_modules`, store)

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', routes])

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })
})
