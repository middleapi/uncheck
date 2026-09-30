import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { LAYOUTS, monorepo, report, temporaryDirectory } from '../utils/project'
import { CLEAN_CODE, CODE_WITH_VAR, selectedReport } from './paths-utils'

const TSC_OF_LAYOUT: Readonly<Record<string, string>> = {
  'single repo': '▶ tsc -p tsconfig.json --noEmit',
  'monorepo': '▶ tsc -b tsconfig.json',
}

describe.each(LAYOUTS)('uncheck selecting files by path in a $name', ({ name, create, app }) => {
  it('checks only the file it is given', async () => {
    const project = create({ [`${app}src/legacy.ts`]: CODE_WITH_VAR })

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--only=oxlint',
      `${app}src/index.ts`,
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

  it('checks every file below a directory it is given', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/routes/nested/legacy.ts`]: CODE_WITH_VAR,
      [`${app}scripts/legacy.ts`]: CODE_WITH_VAR,
    })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', `${app}src/routes/`])

    expect(exitCode).toBe(1)
    expect(stdout).toContain(`${app}src/routes/nested/legacy.ts:1:1: error eslint(no-var)`)
    expect(stdout).not.toContain('scripts/legacy.ts')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/routes/home.ts ${app}src/routes/nested/legacy.ts`,
      '✘ oxlint failed',
      '✘ 1 of 1 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
  })

  it('hands oxlint and oxfmt the same files and runs tsc on the config covering them', async () => {
    const project = create({ [`${app}src/extra.ts`]: CLEAN_CODE })

    const { exitCode, stdout, stderr } = await project.uncheck([
      `${app}src/index.ts`,
      `${app}src/extra.ts`,
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/extra.ts ${app}src/index.ts`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}src/extra.ts ${app}src/index.ts`,
      '✔ oxfmt passed',
      TSC_OF_LAYOUT[name],
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
  })

  it('lists every file for "." but leaves the choice to each tool without paths', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/routes/legacy.ts`]: CODE_WITH_VAR,
    })

    const dot = await project.uncheck(['--only=oxlint', '--only=oxfmt', '.'], {
      cwd: `${app}src/routes`,
    })
    const everything = await project.uncheck(['--only=oxlint', '--only=oxfmt'], {
      cwd: `${app}src/routes`,
    })

    expect(dot.exitCode).toBe(1)
    expect(selectedReport(dot.stdout)).toEqual([
      `uncheck in ${project.path(app, 'src/routes')}`,
      '▶ oxlint --no-error-on-unmatched-pattern home.ts legacy.ts',
      '✘ oxlint failed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern home.ts legacy.ts',
      '✔ oxfmt passed',
      '✘ 1 of 2 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
    expect(everything.exitCode).toBe(1)
    expect(selectedReport(everything.stdout)).toEqual([
      `uncheck in ${project.path(app, 'src/routes')}`,
      '▶ oxlint',
      '✘ oxlint failed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      '✘ 1 of 2 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
  })

  it('checks a file named by several paths once', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/routes/nested/about.ts`]: CLEAN_CODE,
    })

    const { exitCode, stdout } = await project.uncheck([
      '--only=oxlint',
      `${app}src/routes/nested`,
      `${app}src/routes/*.ts`,
      `${app}src/routes/home.ts`,
      `./${app}src/routes/nested/../home.ts`,
    ])

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/routes/home.ts ${app}src/routes/nested/about.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('resolves paths against --cwd rather than the directory it starts in', async () => {
    const project = create({ 'index.ts': CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck([
      '--only=oxlint',
      `--cwd=${app}src`,
      'index.ts',
    ])

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      '▶ oxlint --no-error-on-unmatched-pattern index.ts',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('resolves paths against the subdirectory it starts in', async () => {
    const project = create({ 'index.ts': CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', 'index.ts'], {
      cwd: `${app}src`,
    })

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      '▶ oxlint --no-error-on-unmatched-pattern index.ts',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('follows "../" back into the directory it runs in', async () => {
    const project = create({ [`${app}src/routes/home.ts`]: CLEAN_CODE })

    const { exitCode, stdout } = await project.uncheck(
      ['--only=oxlint', '../routes/home.ts', '../routes'],
      { cwd: `${app}src/routes` },
    )

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src/routes')}`,
      '▶ oxlint --no-error-on-unmatched-pattern home.ts',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('matches nothing with a directory or glob above the directory it runs in', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/legacy.ts`]: CODE_WITH_VAR,
    })
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'shared.ts'), CLEAN_CODE)

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['--only=oxlint', '..', '../*.ts', outside],
      { cwd: `${app}src/routes` },
    )

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck in ${project.path(app, 'src/routes')}`])
    expect(stderr).toBe(
      `\nERROR\n  No files match .., ../*.ts, ${outside}. Pass --no-error-on-unmatched-pattern to run with whatever matched.\n`,
    )
  })

  it('hands oxlint and oxfmt a file above the directory it runs in as a "../" path they reject', async () => {
    const project = create()
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'shared.ts'), CLEAN_CODE)
    const handed = relative(project.dir, join(outside, 'shared.ts'))

    const { exitCode, stdout, stderr } = await project.uncheck([
      '--only=oxlint',
      '--only=oxfmt',
      join(outside, 'shared.ts'),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(1)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${handed}`,
      '✘ oxlint failed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${handed}`,
      '✘ oxfmt failed',
      '✘ 2 of 2 checks failed: oxlint, oxfmt',
      '  rerun with `--fix` to apply oxlint and oxfmt fixes',
    ])
    expect(
      stdout
        .split('\n')
        .filter((line) => line === `Error: \`${handed}\`: PATH must not contain ".."`),
    ).toHaveLength(2)
  })
})

describe('uncheck selecting files by path in a monorepo package', () => {
  it('resolves paths from the package directory and checks that package alone', async () => {
    const project = monorepo({
      'packages/core/src/legacy.ts': CODE_WITH_VAR,
      'packages/app/src/extra.ts': CLEAN_CODE,
    })

    const { exitCode, stdout, stderr } = await project.uncheck(['src', 'package.json'], {
      cwd: 'packages/app',
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path('packages/app')}`,
      '○ sherif skipped, not a workspace root',
      '▶ oxlint --no-error-on-unmatched-pattern package.json src/extra.ts src/index.ts',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern package.json src/extra.ts src/index.ts',
      '✔ oxfmt passed',
      '▶ tsc -b tsconfig.json',
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
  })
})
