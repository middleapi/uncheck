import { LAYOUTS, monorepo, report } from '../utils/project'
import {
  ALLOW_JS,
  CONFIG_DIR,
  NOT_COVERED,
  OUT_DIR,
  SKIPPED_BESIDE_TSC,
  tscPlan,
  withFakeTsc,
} from './utils'

const NO_JS = { compilerOptions: { allowJs: false } }

describe.each(LAYOUTS)('tsc extends in a $name', ({ create, app }) => {
  it('resolves a relative or absolute extends, with or without .json', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.base.json`]: ALLOW_JS,
      [`${app}web/tsconfig.json`]: { extends: '../tsconfig.base.json', include: ['src'] },
      [`${app}server/tsconfig.json`]: { extends: '../tsconfig.base', include: ['src'] },
      [`${app}docs/tsconfig.json`]: { extends: '..\\tsconfig.base.json', include: ['src'] },
      [`${app}cli/tsconfig.json`]: { extends: './tsconfig.shared.json', include: ['src'] },
      [`${app}cli/tsconfig.shared.json`]: ALLOW_JS,
      [`${app}legacy/tsconfig.json`]: { extends: '../tsconfig.legacy', include: ['src'] },
    })

    project.write({
      [`${app}bin/tsconfig.json`]: {
        extends: project.path(app, 'tsconfig.base.json'),
        include: ['src'],
      },
    })

    const scripts = ['bin', 'cli', 'docs', 'legacy', 'server', 'web'].map(
      (dir) => `${dir}/src/a.js`,
    )

    expect(await tscPlan(project, app, scripts)).toEqual([
      '▶ tsc -p bin/tsconfig.json --noEmit',
      '▶ tsc -p cli/tsconfig.json --noEmit',
      '▶ tsc -p docs/tsconfig.json --noEmit',
      '▶ tsc -p server/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
  })

  it('resolves a package extends to its tsconfig.json, its tsconfig field or a file in it', async () => {
    const project = withFakeTsc(create, {
      'node_modules/@tsconfig/node22/package.json': { name: '@tsconfig/node22', version: '1.0.0' },
      'node_modules/@tsconfig/node22/tsconfig.json': ALLOW_JS,
      'node_modules/tsconfig-preset/package.json': {
        name: 'tsconfig-preset',
        version: '1.0.0',
        tsconfig: './preset.json',
      },
      'node_modules/tsconfig-preset/preset.json': ALLOW_JS,
      'node_modules/@acme/tsconfig/package.json': { name: '@acme/tsconfig', version: '1.0.0' },
      'node_modules/@acme/tsconfig/node.json': ALLOW_JS,
      'node_modules/@acme/tsconfig/web/tsconfig.json': ALLOW_JS,
      [`${app}node/tsconfig.json`]: { extends: '@tsconfig/node22', include: ['src'] },
      [`${app}preset/tsconfig.json`]: { extends: 'tsconfig-preset', include: ['src'] },
      [`${app}file/tsconfig.json`]: { extends: '@acme/tsconfig/node.json', include: ['src'] },
      [`${app}name/tsconfig.json`]: { extends: '@acme/tsconfig/node', include: ['src'] },
      [`${app}folder/tsconfig.json`]: { extends: '@acme/tsconfig/web', include: ['src'] },
      [`${app}missing/tsconfig.json`]: { extends: '@acme/missing', include: ['src'] },
    })

    const scripts = ['file', 'folder', 'missing', 'name', 'node', 'preset'].map(
      (dir) => `${dir}/src/a.js`,
    )

    expect(await tscPlan(project, app, scripts)).toEqual([
      '▶ tsc -p file/tsconfig.json --noEmit',
      '▶ tsc -p folder/tsconfig.json --noEmit',
      '▶ tsc -p name/tsconfig.json --noEmit',
      '▶ tsc -p node/tsconfig.json --noEmit',
      '▶ tsc -p preset/tsconfig.json --noEmit',
    ])
  })

  it('resolves a package extends through the subpaths and conditions of its exports only', async () => {
    const project = withFakeTsc(create, {
      'node_modules/@acme/tsconfig/package.json': {
        name: '@acme/tsconfig',
        version: '1.0.0',
        exports: {
          '.': './tsconfig.json',
          './lib': { import: './esm.json', require: './lib.json' },
          './node': { node: { types: './node.json' } },
          './web': [{ import: './esm.json' }, './web.json'],
          './legacy': null,
        },
      },
      'node_modules/@acme/tsconfig/tsconfig.json': ALLOW_JS,
      'node_modules/@acme/tsconfig/esm.json': NO_JS,
      'node_modules/@acme/tsconfig/lib.json': ALLOW_JS,
      'node_modules/@acme/tsconfig/node.json': ALLOW_JS,
      'node_modules/@acme/tsconfig/web.json': ALLOW_JS,
      'node_modules/@acme/tsconfig/legacy.json': ALLOW_JS,
      [`${app}main/tsconfig.json`]: { extends: '@acme/tsconfig', include: ['src'] },
      [`${app}lib/tsconfig.json`]: { extends: '@acme/tsconfig/lib', include: ['src'] },
      [`${app}node/tsconfig.json`]: { extends: '@acme/tsconfig/node', include: ['src'] },
      [`${app}web/tsconfig.json`]: { extends: '@acme/tsconfig/web', include: ['src'] },
      [`${app}legacy/tsconfig.json`]: { extends: '@acme/tsconfig/legacy', include: ['src'] },
      [`${app}file/tsconfig.json`]: { extends: '@acme/tsconfig/lib.json', include: ['src'] },
    })

    const scripts = ['file', 'legacy', 'lib', 'main', 'node', 'web'].map((dir) => `${dir}/src/a.js`)

    expect(await tscPlan(project, app, scripts)).toEqual([
      '▶ tsc -p lib/tsconfig.json --noEmit',
      '▶ tsc -p main/tsconfig.json --noEmit',
      '▶ tsc -p node/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
  })

  it('resolves a package extends through the * pattern of its exports with the longest prefix', async () => {
    const project = withFakeTsc(create, {
      'node_modules/@acme/presets/package.json': {
        name: '@acme/presets',
        version: '1.0.0',
        exports: {
          './*': './loose/*.json',
          './strict/*': './strict/*.json',
          './s*': './loose/s*.json',
        },
      },
      'node_modules/@acme/presets/loose/web.json': ALLOW_JS,
      'node_modules/@acme/presets/loose/strict/node.json': NO_JS,
      'node_modules/@acme/presets/strict/node.json': ALLOW_JS,
      [`${app}web/tsconfig.json`]: { extends: '@acme/presets/web', include: ['src'] },
      [`${app}node/tsconfig.json`]: { extends: '@acme/presets/strict/node', include: ['src'] },
    })

    expect(await tscPlan(project, app, ['node/src/a.js', 'web/src/a.js'])).toEqual([
      '▶ tsc -p node/tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
  })

  it('never matches a * pattern of its exports longer than the subpath', async () => {
    const project = withFakeTsc(create, {
      'node_modules/tsconfig-pattern/package.json': {
        name: 'tsconfig-pattern',
        version: '1.0.0',
        exports: { './a*a': './tsconfig.json' },
      },
      'node_modules/tsconfig-pattern/tsconfig.json': ALLOW_JS,
      [`${app}short/tsconfig.json`]: { extends: 'tsconfig-pattern/a', include: ['src'] },
      [`${app}long/tsconfig.json`]: { extends: 'tsconfig-pattern/aba', include: ['src'] },
    })

    expect(await tscPlan(project, app, ['long/src/a.js', 'short/src/a.js'])).toEqual([
      '▶ tsc -p long/tsconfig.json --noEmit',
    ])
  })

  it('resolves a package extends through exports given as a path, an array or conditions', async () => {
    const project = withFakeTsc(create, {
      'node_modules/tsconfig-path/package.json': {
        name: 'tsconfig-path',
        version: '1.0.0',
        exports: './tsconfig.json',
      },
      'node_modules/tsconfig-path/tsconfig.json': ALLOW_JS,
      'node_modules/tsconfig-array/package.json': {
        name: 'tsconfig-array',
        version: '1.0.0',
        exports: ['./tsconfig.json'],
      },
      'node_modules/tsconfig-array/tsconfig.json': ALLOW_JS,
      'node_modules/tsconfig-conditions/package.json': {
        name: 'tsconfig-conditions',
        version: '1.0.0',
        exports: { import: './esm.json', default: './tsconfig.json' },
      },
      'node_modules/tsconfig-conditions/esm.json': NO_JS,
      'node_modules/tsconfig-conditions/tsconfig.json': ALLOW_JS,
      [`${app}path/tsconfig.json`]: { extends: 'tsconfig-path', include: ['src'] },
      [`${app}array/tsconfig.json`]: { extends: 'tsconfig-array', include: ['src'] },
      [`${app}conditions/tsconfig.json`]: { extends: 'tsconfig-conditions', include: ['src'] },
    })

    const scripts = ['array', 'conditions', 'path'].map((dir) => `${dir}/src/a.js`)

    expect(await tscPlan(project, app, scripts)).toEqual([
      '▶ tsc -p array/tsconfig.json --noEmit',
      '▶ tsc -p conditions/tsconfig.json --noEmit',
      '▶ tsc -p path/tsconfig.json --noEmit',
    ])
  })

  it('applies the configs of an extends array in order and ignores an invalid extends', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.js.json`]: ALLOW_JS,
      [`${app}tsconfig.ts.json`]: NO_JS,
      [`${app}web/tsconfig.json`]: { extends: ['../tsconfig.ts.json', '../tsconfig.js.json'] },
      [`${app}server/tsconfig.json`]: { extends: ['../tsconfig.js.json', '../tsconfig.ts.json'] },
      [`${app}cli/tsconfig.json`]: { extends: ['../tsconfig.js.json', 42] },
    })

    expect(await tscPlan(project, app, ['cli/a.js', 'server/a.js', 'web/a.js'])).toEqual([
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
  })

  it('stops at circular extends', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: { extends: './tsconfig.src.json' },
      [`${app}web/tsconfig.src.json`]: { extends: './tsconfig.json', include: ['src'] },
    })

    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual([
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
  })

  it('applies a base that two extends branches share in both, like tsc', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.base.json`]: { include: [`${CONFIG_DIR}/lib`] },
      [`${app}tsconfig.src.json`]: {
        extends: './tsconfig.base.json',
        include: [`${CONFIG_DIR}/src`],
      },
      [`${app}tsconfig.strict.json`]: {
        extends: './tsconfig.base.json',
        compilerOptions: { strict: true },
      },
      [`${app}web/tsconfig.json`]: { extends: ['../tsconfig.src.json', '../tsconfig.strict.json'] },
    })

    expect(await tscPlan(project, app, ['web/lib/index.ts'])).toEqual([
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual([NOT_COVERED])
  })

  it('typechecks the projects extending a base deleted with its folder', async () => {
    const project = withFakeTsc(create, {
      [`${app}config/tsconfig.base.json`]: NO_JS,
      [`${app}web/tsconfig.json`]: { extends: '../config/tsconfig.base.json', include: ['src'] },
      [`${app}server/tsconfig.json`]: { include: ['src'] },
    })

    project.git('rm', '--quiet', '-r', '--', `${app}config`)

    const { exitCode, stdout } = await project.uncheck(['staged', '--only=tsc'], { cwd: app })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(app, '.')}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p web/tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
  })
})

describe('tsc extends across the packages of a monorepo', () => {
  it('resolves a package from the node_modules closest to each config', async () => {
    const project = withFakeTsc(monorepo, {
      'node_modules/@acme/tsconfig/package.json': { name: '@acme/tsconfig', version: '1.0.0' },
      'node_modules/@acme/tsconfig/tsconfig.json': ALLOW_JS,
      'packages/app/node_modules/@acme/tsconfig/package.json': {
        name: '@acme/tsconfig',
        version: '2.0.0',
      },
      'packages/app/node_modules/@acme/tsconfig/tsconfig.json': NO_JS,
      'packages/app/tsconfig.json': { extends: '@acme/tsconfig', ...OUT_DIR, include: ['src'] },
      'packages/core/tsconfig.json': { extends: '@acme/tsconfig', ...OUT_DIR, include: ['src'] },
    })

    expect(await tscPlan(project, '', ['packages/core/src/a.js'])).toEqual([
      '▶ tsc -b tsconfig.json',
    ])
    expect(await tscPlan(project, '', ['packages/app/src/a.js'])).toEqual([NOT_COVERED])
  })
})
