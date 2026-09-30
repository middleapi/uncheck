import { LAYOUTS, report } from '../utils/project'
import { layoutChecks } from './utils'

const ONLY_FILE_CHECKS = ['--only=oxlint', '--only=oxfmt']

describe.each(LAYOUTS)('uncheck with paths in a $name', ({ create, app }) => {
  const { tsc } = layoutChecks(app)

  it('checks only the given files with every tool', async () => {
    const project = create({ [`${app}src/legacy.ts`]: 'var count = 1;\nexport { count };\n' })

    const { exitCode, stdout } = await project.uncheck([`${app}src/index.ts`])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
    expect(exitCode).toBe(0)
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
    const project = create({ [`${app}notes.txt`]: 'var   draft\n', [`${app}README.md`]: '# App\n' })

    const { exitCode, stdout } = await project.uncheck([`${app}notes.txt`, `${app}README.md`])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}README.md ${app}notes.txt`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}README.md ${app}notes.txt`,
      '✔ oxfmt passed',
      '○ tsc skipped, no tsconfig.json covers the given files',
      '✔ all checks passed (oxlint, oxfmt)',
    ])
    expect(exitCode).toBe(0)
  })

  it('fails on paths that match no file', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck([
      `${app}src/index.ts`,
      `${app}missing.ts`,
      `${app}lib/**`,
    ])

    expect(report(stdout)).toEqual([`uncheck in ${project.dir}`])
    expect(stderr).toBe(
      `\nERROR\n  No files match ${app}missing.ts, ${app}lib/**. Pass --no-error-on-unmatched-pattern to run with whatever matched.\n`,
    )
    expect(exitCode).toBe(1)
  })

  it('runs with whatever matched when unmatched patterns are allowed', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck([
      '--no-error-on-unmatched-pattern',
      ...ONLY_FILE_CHECKS,
      `${app}src/index.ts`,
      `${app}missing.ts`,
    ])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxlint passed',
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${app}src/index.ts`,
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint, oxfmt)',
    ])
    expect(exitCode).toBe(0)
  })

  it('passes when nothing matches and unmatched patterns are allowed', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck([
      '--no-error-on-unmatched-pattern',
      `${app}missing.ts`,
    ])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `○ nothing to check, no files match ${app}missing.ts`,
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

    expect(report(three.stdout)).toContain(
      `▶ oxlint --no-error-on-unmatched-pattern ${app}lib/a.ts ${app}lib/b.ts ${app}lib/c.ts`,
    )
    expect(three.exitCode).toBe(0)

    const four = await project.uncheck(['--only=oxlint', `${app}lib`])

    expect(report(four.stdout)).toContain('▶ oxlint --no-error-on-unmatched-pattern [4 files]')
    expect(four.exitCode).toBe(0)
  })

  it('splits a file list too long for one command line into several runs', async () => {
    const name = (index: number) =>
      `${app}generated/${'x'.repeat(80 - app.length)}${String(index).padStart(4, '0')}.ts`
    const files = Object.fromEntries(
      Array.from({ length: 301 }, (_, index) => [name(index), 'export const value = 1;\n']),
    )
    const project = create({ ...files, [name(300)]: 'var value = 1;\nexport { value };\n' })

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
      [`${app}-draft.ts`]: 'var draft = 1;\nexport { draft };\n',
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
    expect(project.read(`${app}-draft.ts`)).toBe('const draft = 1;\nexport { draft };\n')
    expect(project.read(`${app}!notes.ts`)).toBe('export const notes = 1;\n')
  })
})
