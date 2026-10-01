import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { LAYOUTS, report, temporaryDirectory } from '../utils/project'
import { CLEAN_CODE, CODE_WITH_VAR, NOT_COVERED, selectedReport } from './utils'

const ONLY_FILE_CHECKS = ['--only=oxlint', '--only=oxfmt']

describe.each(LAYOUTS)('uncheck handing files to the tools in a $name', ({ create, app, tsc }) => {
  it('hands oxlint and oxfmt the given files alone and runs tsc on the config covering them', async () => {
    const project = create({
      [`${app}src/extra.ts`]: CLEAN_CODE,
      [`${app}src/legacy.ts`]: CODE_WITH_VAR,
    })

    const { exitCode, stdout, stderr } = await project.uncheck([
      `${app}src/index.ts`,
      `${app}src/extra.ts`,
    ])

    expect(stderr).toBe('')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/extra.ts ${app}src/index.ts`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}src/extra.ts ${app}src/index.ts`,
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
    expect(exitCode).toBe(0)
  })

  it('lists every file for "." but leaves the choice to each tool without paths', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/routes/legacy.ts`]: CODE_WITH_VAR,
    })

    const dot = await project.uncheck([...ONLY_FILE_CHECKS, '.'], { cwd: `${app}src/routes` })
    const everything = await project.uncheck(ONLY_FILE_CHECKS, { cwd: `${app}src/routes` })

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

  it('fixes only the given files', async () => {
    const broken = 'var point = {x:1,\n y:2}\nexport { point }\n'
    const project = create({ [`${app}src/given.ts`]: broken, [`${app}src/other.ts`]: broken })

    const { exitCode, stdout } = await project.uncheck(['--fix', `${app}src/given.ts`])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      `▶ oxlint --fix --no-error-on-unmatched-pattern ${app}src/given.ts`,
      '✔ oxlint passed',
      `▶ oxfmt --no-error-on-unmatched-pattern ${app}src/given.ts`,
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
    expect(exitCode).toBe(0)
    expect(project.read(`${app}src/given.ts`)).toBe(
      'const point = { x: 1, y: 2 };\nexport { point };\n',
    )
    expect(project.read(`${app}src/other.ts`)).toBe(broken)
  })

  it('passes files that no tool handles to the linter and formatter without failing', async () => {
    const project = create({
      [`${app}notes.txt`]: 'var   draft\n',
      [`${app}README.md`]: '# App\n',
    })

    const { exitCode, stdout } = await project.uncheck([`${app}notes.txt`, `${app}README.md`])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}README.md ${app}notes.txt`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}README.md ${app}notes.txt`,
      '✔ oxfmt passed',
      NOT_COVERED,
      '✔ all checks passed (oxlint, oxfmt)',
    ])
    expect(exitCode).toBe(0)
  })

  it('lists up to three files on the command line and counts more', async () => {
    const project = create({
      [`${app}lib/a.ts`]: 'export const a = 1;\n',
      [`${app}lib/b.ts`]: 'export const b = 2;\n',
      [`${app}lib/c.ts`]: 'export const c = 3;\n',
      [`${app}lib/d.ts`]: 'export const d = 4;\n',
    })

    const three = await project.uncheck([
      '--only=oxlint',
      `${app}lib/c.ts`,
      `${app}lib/a.ts`,
      `${app}lib/b.ts`,
    ])

    expect(selectedReport(three.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${app}lib/a.ts ${app}lib/b.ts ${app}lib/c.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
    expect(three.exitCode).toBe(0)

    const four = await project.uncheck(['--only=oxlint', `${app}lib`])

    expect(selectedReport(four.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ oxlint --no-error-on-unmatched-pattern [4 files]',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
    expect(four.exitCode).toBe(0)
  })

  it('splits a file list too long for one command line into several runs', async () => {
    const name = (index: number) =>
      `${app}generated/${'x'.repeat(80 - app.length)}${String(index).padStart(4, '0')}.ts`
    const files = Object.fromEntries(
      Array.from({ length: 301 }, (_, index) => [name(index), 'export const value = 1;\n']),
    )
    const project = create({ ...files, [name(300)]: CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck([...ONLY_FILE_CHECKS, `${app}generated`])

    expect(stdout).toContain('eslint(no-var)')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --no-error-on-unmatched-pattern [300 files]',
      `▶ oxlint --no-error-on-unmatched-pattern ${name(300)}`,
      '✘ oxlint failed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern [300 files]',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${name(300)}`,
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✘ 1 of 2 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('hands tools file names starting with - or ! as files', async () => {
    const project = create({
      [`${app}-draft.ts`]: CODE_WITH_VAR,
      [`${app}!notes.ts`]: 'export const   notes = 1\n',
    })

    const check = await project.uncheck([...ONLY_FILE_CHECKS, '*.ts'], { cwd: app })

    expect(check.stdout).toContain('-draft.ts')
    expect(check.stdout).toContain('eslint(no-var)')
    expect(check.stdout).toContain('!notes.ts')
    expect(report(check.stdout)).toEqual([
      `uncheck in ${project.path(app, '.')}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --no-error-on-unmatched-pattern !notes.ts -draft.ts',
      '✘ oxlint failed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern !notes.ts -draft.ts',
      '✘ oxfmt failed',
      '○ tsc skipped, not selected by --only',
      '✘ 2 of 2 checks failed: oxlint, oxfmt',
      '  rerun with `--fix` to apply oxlint and oxfmt fixes',
    ])
    expect(check.exitCode).toBe(1)

    const fix = await project.uncheck(['--fix', ...ONLY_FILE_CHECKS, '*.ts'], { cwd: app })

    expect(fix.exitCode).toBe(0)
    expect(project.read(`${app}-draft.ts`)).toBe('const count = 1;\nexport { count };\n')
    expect(project.read(`${app}!notes.ts`)).toBe('export const notes = 1;\n')
  })

  it('hands oxlint and oxfmt a file above the directory it runs in as a "../" path they reject', async () => {
    const project = create()
    const outside = temporaryDirectory()
    writeFileSync(join(outside, 'shared.ts'), CLEAN_CODE)
    const handed = relative(project.dir, join(outside, 'shared.ts'))

    const { exitCode, stdout, stderr } = await project.uncheck([
      ...ONLY_FILE_CHECKS,
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
