import { LAYOUTS, monorepo, report, wrappedGit } from '../utils/project'
import {
  ALLOW_JS,
  CONFIG_DIR,
  NOT_COVERED,
  SKIPPED_BESIDE_TSC,
  tscPlan,
  withFakeTsc,
} from './utils'

describe.each(LAYOUTS)('tsc inputs in a $name', ({ create, app }) => {
  it('takes files, include and exclude from the last config setting them, relative to it', async () => {
    const project = withFakeTsc(create, {
      [`${app}config/tsconfig.base.json`]: { include: ['../lib'], exclude: ['../lib/vendor'] },
      [`${app}web/tsconfig.json`]: { extends: '../config/tsconfig.base.json' },
      [`${app}server/tsconfig.json`]: {
        extends: '../config/tsconfig.base.json',
        include: ['src'],
      },
      [`${app}cli/tsconfig.json`]: {
        extends: ['../config/tsconfig.base.json', './tsconfig.entry.json'],
      },
      [`${app}cli/tsconfig.entry.json`]: { files: ['main.ts'] },
      [`${app}docs/tsconfig.json`]: { files: ['index.ts'] },
    })

    expect(await tscPlan(project, app, ['lib/index.ts'])).toEqual([
      '▶ tsc -p cli/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, ['cli/main.ts', 'docs/index.ts', 'server/src/index.ts']),
    ).toEqual([
      '▶ tsc -p cli/tsconfig.json --noEmit',
      '▶ tsc -p docs/tsconfig.json --noEmit',
      '▶ tsc -p server/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, ['docs/guide.ts', 'lib/vendor/index.ts', 'web/lib/index.ts']),
    ).toEqual([NOT_COVERED])
  })

  it(`reads ${CONFIG_DIR} as the folder of the config that extends the shared one`, async () => {
    const project = withFakeTsc(create, {
      [`${app}config/tsconfig.base.json`]: {
        files: [`${CONFIG_DIR}/env.d.ts`],
        include: [`${CONFIG_DIR}/src`],
        exclude: [`${CONFIG_DIR}/src/generated`],
      },
      [`${app}web/tsconfig.json`]: { extends: '../config/tsconfig.base.json' },
      [`${app}server/tsconfig.json`]: { extends: '../config/tsconfig.base.json' },
    })

    expect(await tscPlan(project, app, ['server/env.d.ts', 'web/src/index.ts'])).toEqual([
      '▶ tsc -p server/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, ['config/src/index.ts', 'web/src/generated/api.ts']),
    ).toEqual([NOT_COVERED])
  })

  it('leaves out outDir and declarationDir unless exclude is set', async () => {
    const project = withFakeTsc(create, {
      [`${app}config/tsconfig.build.json`]: {
        compilerOptions: { outDir: `${CONFIG_DIR}/build` },
      },
      [`${app}web/tsconfig.json`]: { compilerOptions: { outDir: 'dist', declarationDir: 'types' } },
      [`${app}server/tsconfig.json`]: {
        compilerOptions: { outDir: 'dist' },
        exclude: ['**/*.test.ts'],
      },
      [`${app}cli/tsconfig.json`]: { extends: '../config/tsconfig.build.json' },
    })

    expect(
      await tscPlan(project, app, ['cli/src/index.ts', 'server/dist/index.ts', 'web/src/index.ts']),
    ).toEqual([
      '▶ tsc -p cli/tsconfig.json --noEmit',
      '▶ tsc -p server/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, [
        'cli/build/index.d.ts',
        'server/src/index.test.ts',
        'web/dist/index.d.ts',
        'web/types/index.d.ts',
      ]),
    ).toEqual([NOT_COVERED])
  })

  it('selects JavaScript files only when allowJs or checkJs is on', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.js.json`]: ALLOW_JS,
      [`${app}js/tsconfig.json`]: { extends: '../tsconfig.js.json' },
      [`${app}ts/tsconfig.json`]: {
        extends: '../tsconfig.js.json',
        compilerOptions: { allowJs: false },
      },
      [`${app}check/tsconfig.json`]: { compilerOptions: { checkJs: true } },
      [`${app}both/tsconfig.json`]: { compilerOptions: { allowJs: false, checkJs: true } },
      [`${app}plain/tsconfig.json`]: { compilerOptions: { strict: true } },
    })

    expect(
      await tscPlan(project, app, [
        'both/index.js',
        'check/index.mjs',
        'js/index.js',
        'plain/index.cjs',
        'ts/index.jsx',
      ]),
    ).toEqual([
      '▶ tsc -p both/tsconfig.json --noEmit',
      '▶ tsc -p check/tsconfig.json --noEmit',
      '▶ tsc -p js/tsconfig.json --noEmit',
    ])
  })

  it('selects a JavaScript file named in the files list even without allowJs', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: { files: ['legacy.js'], include: ['src'] },
    })

    expect(await tscPlan(project, app, ['web/legacy.js'])).toEqual([
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['web/src/legacy.js'])).toEqual([NOT_COVERED])
  })

  it('selects a JSON file only through the files list or an include ending in .json', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: { include: ['src', 'config/*.json'] },
      [`${app}server/tsconfig.json`]: { files: ['data.json'], include: ['src'] },
    })

    expect(await tscPlan(project, app, ['server/data.json', 'web/config/app.json'])).toEqual([
      '▶ tsc -p server/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['server/src/data.json', 'web/src/data.json'])).toEqual([
      NOT_COVERED,
    ])
  })

  it('selects a changed config and every config that extends it', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.base.json`]: { compilerOptions: { strict: true } },
      [`${app}web/tsconfig.json`]: { extends: '../tsconfig.base.json', include: ['src'] },
      [`${app}server/tsconfig.json`]: { extends: '../tsconfig.base.json', include: ['src'] },
      [`${app}cli/tsconfig.json`]: { include: ['src'] },
    })

    expect(await tscPlan(project, app, ['cli/tsconfig.json', 'tsconfig.base.json'])).toEqual([
      '▶ tsc -p cli/tsconfig.json --noEmit',
      '▶ tsc -p server/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['package.json'])).toEqual([NOT_COVERED])
  })

  it('reads a tsconfig.json with comments and trailing commas', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: '{\n  // Only the library.\n  "include": ["lib",],\n}\n',
    })

    expect(await tscPlan(project, app, ['web/lib/index.ts'])).toEqual([
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual([NOT_COVERED])
  })

  it('still plans the other files when a given JSON file is deleted while uncheck runs', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: { include: ['src'] },
      [`${app}web/src/index.ts`]: '',
      [`${app}web/data.json`]: '{}\n',
    })

    const { exitCode, stdout } = await project.uncheck(
      ['--only=tsc', 'web/src/index.ts', 'web/data.json'],
      { cwd: app, env: wrappedGit('[ "$1" = ls-files ] && rm -f web/data.json') },
    )

    expect(project.exists(`${app}web/data.json`)).toBe(false)
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path(app, '.')}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p web/tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
  })
})

describe('tsc inputs across the packages of a monorepo', () => {
  it('selects the configs that extend a changed workspace config package by its real path', async () => {
    const project = withFakeTsc(monorepo, {
      'packages/tsconfig/package.json': {
        name: '@repo/tsconfig',
        version: '1.0.0',
        private: true,
      },
      'packages/tsconfig/base.json': {
        compilerOptions: { strict: true, outDir: `${CONFIG_DIR}/dist` },
      },
      'packages/app/tsconfig.json': { extends: '@repo/tsconfig/base.json', include: ['src'] },
    }).link('packages/app/node_modules/@repo/tsconfig', '../../../tsconfig')

    expect(await tscPlan(project, '', ['packages/tsconfig/base.json'])).toEqual([
      '▶ tsc -b tsconfig.json',
    ])
    expect(await tscPlan(project, '', ['packages/tsconfig/package.json'])).toEqual([NOT_COVERED])
  })

  it('checks a shared base kept as a tsconfig.json with no sources only through the configs extending it', async () => {
    const project = withFakeTsc(monorepo, {
      'packages/tsconfig/package.json': {
        name: '@repo/tsconfig',
        version: '1.0.0',
        private: true,
      },
      'packages/tsconfig/tsconfig.json': {
        compilerOptions: { strict: true, outDir: `${CONFIG_DIR}/dist` },
      },
      'packages/app/tsconfig.json': {
        extends: '@repo/tsconfig',
        references: [{ path: '../core' }],
        include: ['src'],
      },
      'packages/web/tsconfig.json': { include: ['src'] },
      'packages/web/src/index.ts': '',
      'packages/web/test/tsconfig.json': { extends: '../tsconfig.json', include: ['.'] },
      'packages/docs/tsconfig.json': { include: ['scr'] },
    }).link('packages/app/node_modules/@repo/tsconfig', '../../../tsconfig')

    expect(await tscPlan(project, '')).toEqual([
      '▶ tsc -b tsconfig.json',
      '▶ tsc -p packages/docs/tsconfig.json --noEmit',
      '▶ tsc -p packages/web/test/tsconfig.json --noEmit',
      '▶ tsc -p packages/web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, '', ['packages/tsconfig/tsconfig.json'])).toEqual([
      '▶ tsc -b tsconfig.json',
    ])
  })
})
