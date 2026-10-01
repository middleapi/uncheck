import { LAYOUTS, monorepo, PERMISSIONS_ENFORCED, report, run, singleRepo } from '../utils/project'
import {
  ALLOW_JS,
  CLEAN_CODE,
  CODE_WITH_TYPE_ERROR,
  NOT_COVERED,
  OUT_DIR,
  SKIPPED_BESIDE_TSC,
  tscPlan,
  withFakeTsc,
} from './utils'

describe.each(LAYOUTS)('tsc in a $name', ({ create, app, tsc }) => {
  const uncoveredFolder =
    app === '' ? 'no tsconfig.json found' : 'no tsconfig.json covers this folder'

  it('skips the check when no tsconfig.json covers the folder', async () => {
    const project = create({ [`${app}tsconfig.json`]: null })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'], { cwd: app })

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path(app, '.')}`,
      ...SKIPPED_BESIDE_TSC,
      `○ tsc skipped, ${uncoveredFolder}`,
      `✘ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc ${uncoveredFolder}`,
    ])
  })

  it('skips a tracked tsconfig.json deleted from the working tree', async () => {
    const project = withFakeTsc(create).write({ [`${app}tsconfig.json`]: null })

    expect(project.git('ls-files', `${app}tsconfig.json`)).toBe(`${app}tsconfig.json\n`)
    expect(await tscPlan(project, app)).toEqual([`○ tsc skipped, ${uncoveredFolder}`])
  })

  it('checks a folder below its tsconfig.json with that config, if it includes files of the folder', async () => {
    const project = withFakeTsc(create, { [`${app}scripts/release.ts`]: '' })
    const inherited = tsc.replace('tsconfig.json', '../tsconfig.json')

    expect(await tscPlan(project, `${app}src`)).toEqual([inherited])
    expect(await tscPlan(project, `${app}src`, ['index.ts'])).toEqual([inherited])
    expect(await tscPlan(project, `${app}scripts`)).toEqual([
      '○ tsc skipped, no tsconfig.json covers this folder',
    ])
    expect(await tscPlan(project, `${app}scripts`, ['release.ts'])).toEqual([NOT_COVERED])
  })

  it('checks a tsconfig.json with merge conflicts once', async () => {
    const project = withFakeTsc(create)
    const config = `${app}tsconfig.json`
    const include = (folder: string) => (value: Record<string, unknown>) => ({
      ...value,
      include: ['src', folder],
    })

    project.git('checkout', '--quiet', '-b', 'side')
    project.update(config, include('side')).commit('side')
    project.git('checkout', '--quiet', 'main')
    project.update(config, include('main')).commit('main')

    expect((await run(['git', 'merge', 'side'], { cwd: project.dir })).exitCode).toBe(1)

    project.git('checkout', '--theirs', '--', config)

    expect(project.git('ls-files', '--', config)).toBe(`${config}\n`.repeat(3))
    expect(await tscPlan(project, app)).toEqual([tsc])
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
      `uncheck in ${project.path(app, '.')}`,
      ...SKIPPED_BESIDE_TSC,
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
      `uncheck in ${project.path(app, '.')}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(stdout).toContain("tsconfig.json(1,1): error TS1005: '{' expected.")
  })

  it.runIf(PERMISSIONS_ENFORCED)(
    'hands an unreadable tsconfig.json to tsc, which reports it',
    async () => {
      const project = create().chmod(`${app}tsconfig.json`, 0)

      const { exitCode, stdout } = await project.uncheck(['--only=tsc', 'src/index.ts'], {
        cwd: app,
      })

      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        ...SKIPPED_BESIDE_TSC,
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
        [`${app}web/tsconfig.json`]: { ...OUT_DIR, include: ['src'] },
        [`${app}scripts/tsconfig.json`]: { include: ['.'] },
        [`${app}node_modules/@tsconfig/node22/tsconfig.json`]: ALLOW_JS,
        [`${app}web/node_modules/lib/tsconfig.json`]: {},
      },
      { git: 'none' },
    )

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b tsconfig.json',
      '▶ tsc -p scripts/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual(['▶ tsc -b tsconfig.json'])
  })
})

describe('tsc with the real compiler in a single repo', () => {
  it('typechecks a folder below the tsconfig.json with it, as tsc does', async () => {
    const project = singleRepo({
      'src/index.ts': CODE_WITH_TYPE_ERROR,
      'scripts/release.ts': CLEAN_CODE,
    })
    const failedIn = (folder: string) => [
      `uncheck in ${project.path(folder)}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p ../tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ]
    const diagnostic =
      "index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."

    const inside = await project.uncheck(['--only=tsc'], { cwd: 'src' })

    expect(inside.exitCode).toBe(1)
    expect(report(inside.stdout)).toEqual(failedIn('src'))
    expect(inside.stdout).toContain(`\n${diagnostic}`)

    const given = await project.uncheck(['--only=tsc', '--cwd', 'src', 'index.ts'])

    expect(given.exitCode).toBe(1)
    expect(report(given.stdout)).toEqual(failedIn('src'))
    expect(given.stdout).toContain(`\n${diagnostic}`)

    const outside = await project.uncheck(['--only=tsc'], { cwd: 'scripts' })

    expect(outside.exitCode).toBe(1)
    expect(report(outside.stdout)).toEqual([
      `uncheck in ${project.path('scripts')}`,
      ...SKIPPED_BESIDE_TSC,
      '○ tsc skipped, no tsconfig.json covers this folder',
      '✘ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers this folder',
    ])
  })

  it.runIf(PERMISSIONS_ENFORCED)(
    'hands a tsconfig.json in a folder it cannot open to tsc, which reports it',
    async () => {
      const project = singleRepo({ 'locked/tsconfig.json': { include: ['.'] } }).chmod('locked', 0)

      const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual([
        `uncheck in ${project.dir}`,
        ...SKIPPED_BESIDE_TSC,
        '▶ tsc -p locked/tsconfig.json --noEmit',
        '▶ tsc -p tsconfig.json --noEmit',
        '✘ tsc failed',
        '✘ 1 of 1 checks failed: tsc',
      ])
      expect(stdout).toContain(
        `error TS5058: The specified path does not exist: '${project.path('locked/tsconfig.json')}'.`,
      )
    },
  )

  it('typechecks a tsconfig.json with -p --noEmit, emitting nothing', async () => {
    const project = singleRepo({
      'tsconfig.json': {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', types: [] },
        include: ['src'],
      },
    })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(project.exists('src/index.js')).toBe(false)
  })
})

describe('tsc with the real compiler in a monorepo', () => {
  it('builds the solution tsconfig.json with -b and reports errors in the package having them', async () => {
    const project = monorepo()

    const passed = await project.uncheck(['--only=tsc'])

    expect(passed.exitCode).toBe(0)
    expect(report(passed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
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
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -b tsconfig.json',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(failed.stdout).toContain(
      "packages/core/src/index.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
  })
})
