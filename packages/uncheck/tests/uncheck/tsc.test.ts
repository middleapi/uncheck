import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'

import { LAYOUTS, monorepo, report, singleRepo } from '../utils/project'
import { ALLOW_JS, NOT_COVERED, SKIPPED_BY_ONLY, tscPlan, withFakeTsc } from './tsc.utils'

describe.each(LAYOUTS)('tsc in a $name', ({ create, app }) => {
  it('skips the check when the project has no tsconfig.json', async () => {
    const project = create({ [`${app}tsconfig.json`]: null })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'], { cwd: app })

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${resolve(project.dir, app)}`,
      ...SKIPPED_BY_ONLY,
      '○ tsc skipped, no tsconfig.json found',
      '✘ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json found',
    ])
  })

  it('skips a tracked tsconfig.json deleted from the working tree', async () => {
    const project = withFakeTsc(create).write({ [`${app}tsconfig.json`]: null })

    expect(project.git('ls-files', `${app}tsconfig.json`)).toBe(`${app}tsconfig.json\n`)
    expect(await tscPlan(project, app)).toEqual(['○ tsc skipped, no tsconfig.json found'])
  })

  it('skips the check when no tsconfig.json covers the given files', async () => {
    const project = withFakeTsc(create, { [`${app}README.md`]: '# App\n' })

    expect(await tscPlan(project, app, ['README.md', 'src/LEGACY.TS'])).toEqual([NOT_COVERED])
    expect(await tscPlan(project, app, ['README.md', 'scripts/release.ts'])).toEqual([NOT_COVERED])
  })

  it('fails when typescript is not installed, counting the configs it would check', async () => {
    const project = create({ [`${app}scripts/tsconfig.json`]: { include: ['.'] } }, { tools: [] })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'], { cwd: app })

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${resolve(project.dir, app)}`,
      ...SKIPPED_BY_ONLY,
      '✘ tsc found 2 tsconfig.json but typescript is not installed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(await tscPlan(project, app, ['scripts/release.ts'])).toEqual([
      '✘ tsc found 1 tsconfig.json but typescript is not installed',
    ])
  })

  it('hands a malformed tsconfig.json to tsc, which reports it', async () => {
    const project = create({ [`${app}tsconfig.json`]: 'oops\n', [`${app}scripts/release.ts`]: '' })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc', 'scripts/release.ts'], {
      cwd: app,
    })

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${resolve(project.dir, app)}`,
      ...SKIPPED_BY_ONLY,
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(stdout).toContain("tsconfig.json(1,1): error TS1005: '{' expected.")
  })

  // chmod cannot stop root from reading a file.
  it.skipIf(process.getuid?.() === 0)(
    'hands an unreadable tsconfig.json to tsc, which reports it',
    async () => {
      const project = create()

      chmodSync(project.path(app, 'tsconfig.json'), 0)

      const { exitCode, stdout } = await project.uncheck(['--only=tsc', 'src/index.ts'], {
        cwd: app,
      })

      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual([
        `uncheck in ${resolve(project.dir, app)}`,
        ...SKIPPED_BY_ONLY,
        '▶ tsc -p tsconfig.json --noEmit',
        '✘ tsc failed',
        '✘ 1 of 1 checks failed: tsc',
      ])
      expect(stdout).toContain(
        `error TS5083: Cannot read file '${project.path(app, 'tsconfig.json')}'.`,
      )
    },
  )

  it('finds the tsconfig.json files outside git by walking the folders, never into node_modules', async () => {
    const project = withFakeTsc(
      create,
      {
        [`${app}tsconfig.json`]: { files: [], references: [{ path: './web' }] },
        [`${app}web/tsconfig.json`]: { include: ['src'] },
        [`${app}scripts/tsconfig.json`]: { include: ['.'] },
        [`${app}node_modules/@tsconfig/node22/tsconfig.json`]: ALLOW_JS,
        [`${app}web/node_modules/lib/tsconfig.json`]: {},
      },
      { git: 'none' },
    )

    expect(project.exists('.git')).toBe(false)
    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b tsconfig.json',
      '▶ tsc -p scripts/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual(['▶ tsc -b tsconfig.json'])
  })
})

describe('tsc with the real compiler in a single repo', () => {
  it('typechecks a tsconfig.json with -p --noEmit, emitting nothing', async () => {
    const project = singleRepo({
      'tsconfig.json': {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', types: [] },
        include: ['src'],
      },
    })

    const passed = await project.uncheck(['--only=tsc'])

    expect(passed.exitCode).toBe(0)
    expect(report(passed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BY_ONLY,
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(project.exists('src/index.js')).toBe(false)

    project.write({
      'src/utils.ts':
        'export function double(value: number): number {\n  return String(value);\n}\n',
    })

    const failed = await project.uncheck(['--only=tsc'])

    expect(failed.exitCode).toBe(1)
    expect(report(failed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BY_ONLY,
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(failed.stdout).toContain(
      "src/utils.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
  })
})

describe('tsc with the real compiler in a monorepo', () => {
  it('builds the solution tsconfig.json with -b and reports errors in the package having them', async () => {
    const project = monorepo()

    const passed = await project.uncheck(['--only=tsc'])

    expect(passed.exitCode).toBe(0)
    expect(report(passed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BY_ONLY,
      '▶ tsc -b tsconfig.json',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(project.exists('packages/core/dist/index.d.ts')).toBe(true)

    project.write({
      'packages/core/src/index.ts':
        'export function double(value: number): number {\n  return String(value);\n}\n',
    })

    const failed = await project.uncheck(['--only=tsc', 'packages/core/src/index.ts'])

    expect(failed.exitCode).toBe(1)
    expect(report(failed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BY_ONLY,
      '▶ tsc -b tsconfig.json',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(failed.stdout).toContain(
      "packages/core/src/index.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
  })
})
