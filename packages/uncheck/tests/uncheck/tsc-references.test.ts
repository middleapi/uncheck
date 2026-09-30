import { LAYOUTS, monorepo, report } from '../utils/project'
import { CONFIG_DIR, NOT_COVERED, SKIPPED_BESIDE_TSC, tscPlan, withFakeTsc } from './utils'

describe.each(LAYOUTS)('tsc project references in a $name', ({ create, app }) => {
  it('builds a solution-style tsconfig.json whose references have other names', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      },
      [`${app}tsconfig.app.json`]: { include: ['src'] },
      [`${app}tsconfig.node.json`]: { include: ['vite.config.ts'] },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['vite.config.ts'])).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['scripts/release.ts'])).toEqual([NOT_COVERED])
  })

  it('follows references to a folder, to a .json file and with backslashes', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: [{ path: 'web' }, { path: '.\\server\\tsconfig.build.json' }],
      },
      [`${app}web/tsconfig.json`]: {
        include: ['src'],
        references: [{ path: '../ui/tsconfig.json' }],
      },
      [`${app}ui/tsconfig.json`]: { include: ['src'] },
      [`${app}server/tsconfig.build.json`]: {
        include: ['src'],
        references: [{ path: '..\\shared' }],
      },
      [`${app}shared/tsconfig.json`]: { include: ['src'] },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['server/src/main.ts'])).toEqual(['▶ tsc -b tsconfig.json'])
    expect(
      await tscPlan(project, app, ['shared/src/index.ts', 'ui/src/index.ts', 'web/src/index.ts']),
    ).toEqual(['▶ tsc -b tsconfig.json'])
  })

  it(`follows a reference path with ${CONFIG_DIR} as written, like tsc`, async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['src'] },
      [`${app}web/tsconfig.json`]: { references: [{ path: `${CONFIG_DIR}/../lib` }] },
      [`${app}web/lib/tsconfig.json`]: { include: ['src'] },
      [`${app}lib/tsconfig.json`]: { include: ['src'] },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b web/tsconfig.json',
      '▶ tsc -p lib/tsconfig.json --noEmit',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
  })

  it('ignores references that are not objects with a string path', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: ['./scripts', { path: 42 }, null, { prepend: true }, { path: './lib' }],
      },
      [`${app}lib/tsconfig.json`]: { include: ['src'], references: './scripts' },
      [`${app}scripts/tsconfig.json`]: { include: ['.'] },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b tsconfig.json',
      '▶ tsc -p scripts/tsconfig.json --noEmit',
    ])
  })

  it('builds the roots of the reference graph that depend on the given files', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['scripts'] },
      [`${app}shared/tsconfig.json`]: { include: ['src'] },
      [`${app}web/tsconfig.json`]: { include: ['src'], references: [{ path: '../shared' }] },
      [`${app}server/tsconfig.json`]: { include: ['src'], references: [{ path: '../shared' }] },
      [`${app}cli/tsconfig.json`]: { include: ['src'], references: [{ path: '../server' }] },
      [`${app}e2e/tsconfig.json`]: {
        include: ['src'],
        references: [{ path: '../web' }, { path: '../server' }],
      },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b cli/tsconfig.json e2e/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['shared/src/index.ts'])).toEqual([
      '▶ tsc -b cli/tsconfig.json e2e/tsconfig.json',
    ])
    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual([
      '▶ tsc -b e2e/tsconfig.json',
    ])
    expect(await tscPlan(project, app, ['cli/src/index.ts', 'scripts/release.ts'])).toEqual([
      '▶ tsc -b cli/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
  })

  it('checks each standalone tsconfig.json with -p --noEmit', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['src'] },
      [`${app}scripts/tsconfig.json`]: { include: ['.'] },
      [`${app}test/tsconfig.json`]: { include: ['.'] },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -p scripts/tsconfig.json --noEmit',
      '▶ tsc -p test/tsconfig.json --noEmit',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['test/index.test.ts', 'scripts/release.ts'])).toEqual([
      '▶ tsc -p scripts/tsconfig.json --noEmit',
      '▶ tsc -p test/tsconfig.json --noEmit',
    ])
  })

  it('fails on circular references, naming only the configs on the cycle', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['scripts'] },
      [`${app}api/tsconfig.json`]: { references: [{ path: '../lib' }] },
      [`${app}lib/tsconfig.json`]: { references: [{ path: '../utils' }] },
      [`${app}utils/tsconfig.json`]: { references: [{ path: '../lib' }] },
    })
    const cycle = '✘ tsc circular project references between lib/tsconfig.json, utils/tsconfig.json'

    expect(await tscPlan(project, app)).toEqual([cycle])
    expect(await tscPlan(project, app, ['scripts/release.ts'])).toEqual([cycle])
  })

  it('leaves a reference to a missing config to tsc -b', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['src'], references: [{ path: './legacy' }] },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['legacy/index.ts'])).toEqual([NOT_COVERED])
  })

  it('leaves a reference to a folder named like a config file to tsc -b', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['src'], references: [{ path: './lib.json' }] },
      [`${app}lib.json/index.ts`]: '',
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
  })
})

describe('tsc project references across the packages of a monorepo', () => {
  it('builds every package that references a changed package, and no other', async () => {
    const project = withFakeTsc(monorepo, {
      'tsconfig.json': { include: ['scripts'] },
      'packages/web/package.json': { name: '@repo/web', version: '1.0.0', private: true },
      'packages/web/tsconfig.json': { include: ['src'], references: [{ path: '../core' }] },
      'packages/cli/package.json': { name: '@repo/cli', version: '1.0.0', private: true },
      'packages/cli/tsconfig.json': { include: ['src'] },
    })

    expect(await tscPlan(project, '', ['packages/core/src/index.ts'])).toEqual([
      '▶ tsc -b packages/app/tsconfig.json packages/web/tsconfig.json',
    ])
    expect(await tscPlan(project, '', ['packages/app/src/index.ts'])).toEqual([
      '▶ tsc -b packages/app/tsconfig.json',
    ])
    expect(await tscPlan(project, '', ['packages/cli/src/index.ts', 'scripts/release.ts'])).toEqual(
      ['▶ tsc -p packages/cli/tsconfig.json --noEmit', '▶ tsc -p tsconfig.json --noEmit'],
    )
  })

  it('builds a package from its folder for a change in a package it references', async () => {
    const project = withFakeTsc(monorepo)

    expect(await tscPlan(project, 'packages/app', ['../core/src/index.ts'])).toEqual([
      '▶ tsc -b tsconfig.json',
    ])
  })

  it('checks a package on its own from its folder', async () => {
    const project = withFakeTsc(monorepo)

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'], { cwd: 'packages/core' })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path('packages/core')}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
  })
})
