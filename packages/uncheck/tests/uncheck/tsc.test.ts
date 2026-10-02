import {
  commitOnSide,
  compilerOptions,
  git,
  LAYOUTS,
  monorepo,
  PERMISSIONS_ENFORCED,
  report,
  run,
  singleRepo,
} from '../utils/project'
import {
  ALLOW_JS,
  CLEAN_CODE,
  CODE_WITH_TYPE_ERROR,
  NOT_COVERED,
  OUT_DIR,
  SKIPPED_BESIDE_TSC,
  tscOnlyReport,
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
    const including = (folder: string) => ({
      ...(JSON.parse(project.read(config)) as object),
      include: ['src', folder],
    })

    commitOnSide(project, { [config]: including('side') })
    project.write({ [config]: including('main') }).commit('main')

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
    expect(report(stdout)).toEqual(
      tscOnlyReport(
        `uncheck in ${project.path(app, '.')}`,
        ['▶ tsc -p tsconfig.json --noEmit'],
        'failed',
      ),
    )
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
      expect(report(stdout)).toEqual(
        tscOnlyReport(
          `uncheck in ${project.path(app, '.')}`,
          ['▶ tsc -p tsconfig.json --noEmit'],
          'failed',
        ),
      )
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

describe('tsc in a folder below a tsconfig.json of another project', () => {
  it('never uses a tsconfig.json above the git repository, or above a folder outside one', async () => {
    const project = withFakeTsc(
      singleRepo,
      { 'tsconfig.json': {}, 'repo/src/index.ts': '' },
      { git: 'none' },
    )
    const notFound = ['○ tsc skipped, no tsconfig.json found']

    expect(await tscPlan(project, 'repo/src')).toEqual(notFound)

    git(project.path('repo'), ['init', '--quiet'])

    expect(await tscPlan(project, 'repo')).toEqual(notFound)
    expect(await tscPlan(project, 'repo/src', ['index.ts'])).toEqual(notFound)
  })
})

describe('tsc with the real compiler in a single repo', () => {
  it('typechecks a folder below the tsconfig.json with it, as tsc does', async () => {
    const project = singleRepo({
      'src/index.ts': CODE_WITH_TYPE_ERROR,
      'scripts/release.ts': CLEAN_CODE,
    })
    const failedInSrc = tscOnlyReport(
      `uncheck in ${project.path('src')}`,
      ['▶ tsc -p ../tsconfig.json --noEmit'],
      'failed',
    )
    const diagnostic =
      "index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."

    const inside = await project.uncheck(['--only=tsc'], { cwd: 'src' })

    expect(inside.exitCode).toBe(1)
    expect(report(inside.stdout)).toEqual(failedInSrc)
    expect(inside.stdout).toContain(`\n${diagnostic}`)

    const given = await project.uncheck(['--only=tsc', '--cwd', 'src', 'index.ts'])

    expect(given.exitCode).toBe(1)
    expect(report(given.stdout)).toEqual(failedInSrc)
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

  it('typechecks a folder without its own tsconfig.json with the one above it, next to the ones inside it', async () => {
    const project = singleRepo({
      'web/src/index.ts': CODE_WITH_TYPE_ERROR,
      'web/cypress/tsconfig.json': {
        compilerOptions: { strict: true, noEmit: true, types: [] },
        include: ['**/*.ts'],
      },
      'web/cypress/e2e.ts': CLEAN_CODE,
    }).update('tsconfig.json', (config) => ({ ...config, include: ['web/src'] }))
    const failed = (plan: ReadonlyArray<string>) =>
      tscOnlyReport(`uncheck in ${project.path('web')}`, plan, 'failed')
    const diagnostic =
      "src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."

    const full = await project.uncheck(['--only=tsc'], { cwd: 'web' })

    expect(full.exitCode).toBe(1)
    expect(report(full.stdout)).toEqual(
      failed(['▶ tsc -p ../tsconfig.json --noEmit', '▶ tsc -p cypress/tsconfig.json --noEmit']),
    )
    expect(full.stdout).toContain(`\n${diagnostic}`)

    const given = await project.uncheck(['--only=tsc', 'src/index.ts'], { cwd: 'web' })

    expect(given.exitCode).toBe(1)
    expect(report(given.stdout)).toEqual(failed(['▶ tsc -p ../tsconfig.json --noEmit']))
    expect(given.stdout).toContain(`\n${diagnostic}`)
  })

  it.runIf(PERMISSIONS_ENFORCED)(
    'hands a tsconfig.json in a folder it cannot open to tsc, which reports it',
    async () => {
      const project = singleRepo({ 'locked/tsconfig.json': { include: ['.'] } }).chmod('locked', 0)

      const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual(
        tscOnlyReport(
          `uncheck in ${project.dir}`,
          ['▶ tsc -p locked/tsconfig.json --noEmit', '▶ tsc -p tsconfig.json --noEmit'],
          'failed',
        ),
      )
      expect(stdout).toContain(
        `error TS5058: The specified path does not exist: '${project.path('locked/tsconfig.json')}'.`,
      )
    },
  )

  it('typechecks a tsconfig.json with -p --noEmit, emitting nothing', async () => {
    const project = singleRepo({
      'tsconfig.json': {
        compilerOptions: compilerOptions(),
        include: ['src'],
      },
    })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual(
      tscOnlyReport(`uncheck in ${project.dir}`, ['▶ tsc -p tsconfig.json --noEmit'], 'passed'),
    )
    expect(project.exists('src/index.js')).toBe(false)
  })
})

describe('tsc with the real compiler in a monorepo', () => {
  it('builds the solution tsconfig.json with -b and reports errors in the package having them', async () => {
    const project = monorepo()

    const passed = await project.uncheck(['--only=tsc'])

    expect(passed.exitCode).toBe(0)
    expect(report(passed.stdout)).toEqual(
      tscOnlyReport(`uncheck in ${project.dir}`, ['▶ tsc -b tsconfig.json'], 'passed'),
    )
    expect(project.exists('packages/core/dist/index.d.ts')).toBe(true)

    project.write({
      'packages/core/src/index.ts':
        'export function double(value: number): number {\n  return String(value);\n}\n',
    })

    const failed = await project.uncheck(['--only=tsc', 'packages/core/src/index.ts'])

    expect(failed.exitCode).toBe(1)
    expect(report(failed.stdout)).toEqual(
      tscOnlyReport(`uncheck in ${project.dir}`, ['▶ tsc -b tsconfig.json'], 'failed'),
    )
    expect(failed.stdout).toContain(
      "packages/core/src/index.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
  })
})
