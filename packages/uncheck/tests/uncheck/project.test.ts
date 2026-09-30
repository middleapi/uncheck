import { LAYOUTS, monorepo, report } from '../utils/project'
import { layoutChecks, updateJson } from './utils'

describe.each(LAYOUTS)('uncheck in a $name', ({ create, app }) => {
  const { sherif, tsc, checks } = layoutChecks(app)

  it('passes a clean project', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck()

    expect(stderr).toBe('')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      `✔ all checks passed (${checks.join(', ')})`,
    ])
    expect(exitCode).toBe(0)
  })

  it('fails on a lint error and still runs the other checks', async () => {
    const project = create({ [`${app}src/legacy.ts`]: 'var count = 1;\nexport { count };\n' })

    const { exitCode, stdout, stderr } = await project.uncheck()

    expect(stderr).toBe('')
    expect(stdout).toContain('eslint(no-var)')
    expect(stdout).toContain(`${app}src/legacy.ts`)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint',
      '✘ oxlint failed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      `✘ 1 of ${checks.length} checks failed: oxlint`,
      '  rerun with `--fix` to apply oxlint fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('fails on a formatting issue', async () => {
    const project = create({ [`${app}src/ugly.ts`]: 'export const   ugly = {a:1,\n b:2}\n' })

    const { exitCode, stdout } = await project.uncheck()

    expect(stdout).toContain(`${app}src/ugly.ts`)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✘ oxfmt failed',
      tsc,
      '✔ tsc passed',
      `✘ 1 of ${checks.length} checks failed: oxfmt`,
      '  rerun with `--fix` to apply oxfmt fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('fails on a type error without offering fixes', async () => {
    const project = create({ [`${app}src/broken.ts`]: 'export const broken: number = "42";\n' })

    const { exitCode, stdout } = await project.uncheck()

    expect(stdout).toContain(`${app}src/broken.ts`)
    expect(stdout).toContain('TS2322')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      tsc,
      '✘ tsc failed',
      `✘ 1 of ${checks.length} checks failed: tsc`,
    ])
    expect(exitCode).toBe(1)
  })

  it('fails when a tsconfig.json exists but typescript is not installed', async () => {
    const project = create({}, { tools: ['sherif', 'oxlint', 'oxfmt'] })
    const tsconfigs = app === '' ? 1 : 3

    const { exitCode, stdout } = await project.uncheck()

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      `✘ tsc found ${tsconfigs} tsconfig.json but typescript is not installed`,
      `✘ 1 of ${checks.length} checks failed: tsc`,
    ])
    expect(exitCode).toBe(1)
  })
})

describe('uncheck in a monorepo', () => {
  it('fails on a workspace issue sherif finds', async () => {
    const project = monorepo()
    updateJson(project, 'packages/core/package.json', (manifest) => ({
      ...manifest,
      dependencies: { zod: '^3.0.0' },
    }))
    updateJson(project, 'packages/app/package.json', (manifest) => ({
      ...manifest,
      dependencies: { '@repo/core': 'workspace:*', 'zod': '^3.1.0' },
    }))

    const { exitCode, stdout } = await project.uncheck()

    expect(stdout).toContain('multiple-dependency-versions')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      '▶ tsc -b tsconfig.json',
      '✔ tsc passed',
      '✘ 1 of 4 checks failed: sherif',
      '  rerun with `--fix` to apply sherif fixes',
    ])
    expect(exitCode).toBe(1)
  })
})
