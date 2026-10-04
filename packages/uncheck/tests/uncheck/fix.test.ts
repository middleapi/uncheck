import type { Project } from '../utils/project'
import { FULL_OXFMT_FIX, FULL_OXLINT, FULL_OXLINT_FIX, LAYOUTS, report } from '../utils/project'
import {
  CODE_WITH_TYPE_ERROR,
  CODE_WITH_VAR,
  layoutChecks,
  monorepoWithMismatchedVersions,
  selectedReport,
  UNFORMATTED_CODE,
} from './utils'

describe.each(LAYOUTS)('uncheck --fix in a $name', ({ create, app, tsc }) => {
  const { sherif, checks } = layoutChecks(app)

  it('applies lint fixes and rewrites formatting, then passes', async () => {
    const project = create({
      [`${app}src/legacy.ts`]: CODE_WITH_VAR,
      [`${app}src/ugly.ts`]: UNFORMATTED_CODE,
    })

    const { exitCode, stdout } = await project.uncheck(['--fix'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...layoutChecks(app, { fix: true }).sherif,
      FULL_OXLINT_FIX,
      '✔ oxlint passed',
      FULL_OXFMT_FIX,
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '○ fallow skipped, not installed',
      `✔ all checks passed (${checks.join(', ')})`,
    ])
    expect(exitCode).toBe(0)
    expect(project.read(`${app}src/legacy.ts`)).toBe('const count = 1;\nexport { count };\n')
    expect(project.read(`${app}src/ugly.ts`)).toBe('export const ugly = { a: 1, b: 2 };\n')
  })

  it('offers the fixes of every fixable check that failed', async () => {
    const project = create({
      [`${app}src/legacy.ts`]: CODE_WITH_VAR,
      [`${app}src/ugly.ts`]: UNFORMATTED_CODE,
    })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', '--only=oxfmt'])

    expect(report(stdout).slice(-2)).toEqual([
      '✘ 2 of 2 checks failed: oxlint, oxfmt',
      '  rerun with `--fix` to apply oxlint and oxfmt fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('leaves type errors out of the fixes it offers', async () => {
    const project = create({
      [`${app}src/legacy.ts`]: CODE_WITH_VAR,
      [`${app}src/broken.ts`]: CODE_WITH_TYPE_ERROR,
    })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', '--only=tsc'])

    expect(report(stdout).slice(-2)).toEqual([
      '✘ 2 of 2 checks failed: oxlint, tsc',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('leaves a required check that cannot run out of the fixes it offers', async () => {
    const project = create(
      { [`${app}src/legacy.ts`]: CODE_WITH_VAR },
      { tools: ['sherif', 'oxlint', 'typescript'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--skip=tsc', '--require=oxfmt'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      FULL_OXLINT,
      '✘ oxlint failed',
      '✘ oxfmt not installed',
      '○ tsc skipped, disabled with --skip=tsc',
      '○ fallow skipped, not installed',
      `✘ 2 of ${checks.length - 1} checks failed: oxlint, oxfmt`,
      '  rerun with `--fix` to apply oxlint fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('offers no fixes once --fix ran and a problem remains', async () => {
    const project = create({
      '.oxlintrc.json': { rules: { 'no-console': 'error' } },
      [`${app}src/log.ts`]: 'console.log("hello");\n',
    })

    const { exitCode, stdout } = await project.uncheck(['--fix', '--only=oxlint'])

    expect(stdout).toContain('eslint(no-console)')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      FULL_OXLINT_FIX,
      '✘ oxlint failed',
      '○ oxfmt skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '○ fallow skipped, not selected by --only',
      '✘ 1 of 1 checks failed: oxlint',
    ])
    expect(exitCode).toBe(1)
    expect(project.read(`${app}src/log.ts`)).toBe('console.log("hello");\n')
  })

  it('never lints or fixes installed packages that no ignore rule covers', async () => {
    const dependency = 'packages/a/node_modules/dep/index.js'
    const project = create({ '.gitignore': '/node_modules\n' }).write({
      [dependency]: CODE_WITH_VAR,
    })

    const check = await project.uncheck(['--only=oxlint'])
    const fix = await project.uncheck(['--fix', '--only=oxlint'])

    expect(check.stdout).not.toContain(dependency)
    expect(selectedReport(check.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      FULL_OXLINT,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
    expect(check.exitCode).toBe(0)
    expect(fix.exitCode).toBe(0)
    expect(project.read(dependency)).toBe(CODE_WITH_VAR)
  })
})

function zodVersions(project: Project) {
  return ['core', 'app'].map(
    (name) =>
      (
        JSON.parse(project.read(`packages/${name}/package.json`)) as {
          dependencies: Record<string, string>
        }
      ).dependencies.zod,
  )
}

describe('uncheck --fix in a monorepo', () => {
  it('aligns mismatched versions on the highest one', async () => {
    const project = monorepoWithMismatchedVersions()

    const { exitCode, stdout } = await project.uncheck(['--fix', '--only=sherif'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif --fix --select=highest',
      '✔ sherif passed',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '○ fallow skipped, not selected by --only',
      '✔ all checks passed (sherif)',
    ])
    expect(exitCode).toBe(0)
    expect(zodVersions(project)).toEqual(['^3.1.0', '^3.1.0'])
    expect((await project.uncheck(['--only=sherif'])).exitCode).toBe(0)
  })

  it('leaves the version choice to a sherif config that makes one', async () => {
    const project = monorepoWithMismatchedVersions({ select: 'lowest' })

    const { exitCode, stdout } = await project.uncheck(['--fix', '--only=sherif'])

    expect(report(stdout)).toContain('▶ sherif --fix')
    expect(exitCode).toBe(0)
    expect(zodVersions(project)).toEqual(['^3.0.0', '^3.0.0'])
  })

  it('only reports what sherif finds in CI, where sherif refuses to fix', async () => {
    const project = monorepoWithMismatchedVersions()
    project.write({ 'packages/app/src/legacy.ts': CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck(['--fix', '--skip=tsc'], {
      env: { CI: 'true' },
    })

    expect(stdout).toContain('multiple-dependency-versions')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      FULL_OXLINT_FIX,
      '✔ oxlint passed',
      FULL_OXFMT_FIX,
      '✔ oxfmt passed',
      '○ tsc skipped, disabled with --skip=tsc',
      '○ fallow skipped, not installed',
      '✘ 1 of 3 checks failed: sherif',
    ])
    expect(exitCode).toBe(1)
    expect(project.read('packages/app/src/legacy.ts')).toBe('const count = 1;\nexport { count };\n')
    expect(zodVersions(project)).toEqual(['^3.0.0', '^3.1.0'])
  })

  it.each(['0', ''])('takes CI=%j for CI too', async (ci) => {
    const project = monorepoWithMismatchedVersions()

    const { exitCode, stdout } = await project.uncheck(['--fix', '--only=sherif'], {
      env: { CI: ci },
    })

    expect(stdout).toContain('multiple-dependency-versions')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '○ fallow skipped, not selected by --only',
      '✘ 1 of 1 checks failed: sherif',
    ])
    expect(exitCode).toBe(1)
    expect(zodVersions(project)).toEqual(['^3.0.0', '^3.1.0'])
  })

  it('offers the fixes of three checks as a list', async () => {
    const project = monorepoWithMismatchedVersions()
    project.write({
      'packages/app/src/legacy.ts': CODE_WITH_VAR,
      'packages/app/src/ugly.ts': UNFORMATTED_CODE,
    })

    const { exitCode, stdout } = await project.uncheck(['--skip=tsc'])

    expect(report(stdout).slice(-2)).toEqual([
      '✘ 3 of 3 checks failed: sherif, oxlint, oxfmt',
      '  rerun with `--fix` to apply sherif, oxlint and oxfmt fixes',
    ])
    expect(exitCode).toBe(1)
  })
})
