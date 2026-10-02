import { readFileSync, writeFileSync } from 'node:fs'
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

  it('checks a linked file inside the project but never a linked folder, a broken link or a link into node_modules, as the walk outside git', async () => {
    const store = temporaryDirectory()
    writeFileSync(join(store, 'vendor.ts'), CODE_WITH_VAR)
    const project = create({
      [`${routes}/home.ts`]: CLEAN_CODE,
      [`${routes}/shared/util.ts`]: CODE_WITH_VAR,
      'node_modules/dep/index.ts': CODE_WITH_VAR,
    })
    project
      .link(`${routes}/alias.ts`, 'home.ts')
      .link(`${routes}/broken.ts`, 'missing.ts')
      .link(`${routes}/linked`, 'shared')
      .link(`${routes}/vendor`, store)
      .link(`${routes}/outside.ts`, join(store, 'vendor.ts'))
      .link(`${routes}/installed.ts`, project.path('node_modules/dep/index.ts'))
      .commit()

    const check = await project.uncheck(['--only=oxlint', routes])

    expect(check.exitCode).toBe(1)
    expect(check.stdout).toContain(`${routes}/shared/util.ts:1:1`)
    expect(check.stdout).not.toContain(`${routes}/linked/`)
    expect(check.stdout).not.toContain(`${routes}/vendor/`)
    expect(check.stdout).not.toContain(`${routes}/outside.ts`)
    expect(check.stdout).not.toContain(`${routes}/installed.ts`)
    expect(selectedReport(check.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/alias.ts ${routes}/home.ts ${routes}/shared/util.ts`,
      '✘ oxlint failed',
      '✘ 1 of 1 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])

    const fix = await project.uncheck(['--only=oxlint', '--fix', routes])

    expect(fix.exitCode).toBe(0)
    expect(selectedReport(fix.stdout)).toContain(
      `▶ oxlint --fix --no-error-on-unmatched-pattern ${routes}/alias.ts ${routes}/home.ts ${routes}/shared/util.ts`,
    )
    expect(project.read(`${routes}/shared/util.ts`)).toBe('const count = 1;\nexport { count };\n')
    expect(readFileSync(join(store, 'vendor.ts'), 'utf8')).toBe(CODE_WITH_VAR)
    expect(project.read('node_modules/dep/index.ts')).toBe(CODE_WITH_VAR)
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
