import { LAYOUTS } from '../utils/project'
import { ALLOW_JS, NOT_COVERED, tscPlan, withFakeTsc } from './utils'

describe.each(LAYOUTS)('tsc include and exclude patterns in a $name', ({ create, app }) => {
  it('reads a pattern without extension or wildcard as a folder', async () => {
    const project = withFakeTsc(create, {
      [`${app}folder/tsconfig.json`]: { include: ['lib'] },
      [`${app}slash/tsconfig.json`]: { include: ['.\\lib/'] },
      [`${app}dotted/tsconfig.json`]: { include: ['lib/v1.0'] },
    })

    expect(await tscPlan(project, app, ['folder/lib/deep/index.ts', 'slash/lib/index.ts'])).toEqual(
      ['▶ tsc -p folder/tsconfig.json --noEmit', '▶ tsc -p slash/tsconfig.json --noEmit'],
    )
    expect(await tscPlan(project, app, ['dotted/lib/v1.0/index.ts', 'folder/lib.ts'])).toEqual([
      NOT_COVERED,
    ])
  })

  it('ignores an include that ends in **', async () => {
    const project = withFakeTsc(create, {
      [`${app}bare/tsconfig.json`]: { include: ['src/**'] },
      [`${app}files/tsconfig.json`]: { include: ['src/**/*.ts'] },
    })

    expect(await tscPlan(project, app, ['bare/src/index.ts'])).toEqual([NOT_COVERED])
    expect(await tscPlan(project, app, ['files/src/deep/index.ts'])).toEqual([
      '▶ tsc -p files/tsconfig.json --noEmit',
    ])
  })

  it('never lets * or ? cross a folder', async () => {
    const project = withFakeTsc(create, {
      [`${app}star/tsconfig.json`]: { include: ['scripts/*.ts'] },
      [`${app}question/tsconfig.json`]: { include: ['v?/*.ts'] },
    })

    expect(await tscPlan(project, app, ['question/v1/index.ts', 'star/scripts/build.ts'])).toEqual([
      '▶ tsc -p question/tsconfig.json --noEmit',
      '▶ tsc -p star/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, ['question/v10/index.ts', 'star/scripts/deep/build.ts']),
    ).toEqual([NOT_COVERED])
  })

  it('never matches a dot file with a leading wildcard', async () => {
    const project = withFakeTsc(create, {
      [`${app}star/tsconfig.json`]: { include: ['*.ts'] },
      [`${app}question/tsconfig.json`]: { include: ['?rc.ts'] },
      [`${app}named/tsconfig.json`]: { include: ['.config/*.ts'] },
    })

    expect(
      await tscPlan(project, app, ['named/.config/index.ts', 'question/arc.ts', 'star/index.ts']),
    ).toEqual([
      '▶ tsc -p named/tsconfig.json --noEmit',
      '▶ tsc -p question/tsconfig.json --noEmit',
      '▶ tsc -p star/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['question/.rc.ts', 'star/.eslintrc.ts'])).toEqual([
      NOT_COVERED,
    ])
  })

  it('skips node_modules and dot folders unless the pattern names them', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: { include: ['src'] },
      [`${app}vendor/tsconfig.json`]: { include: ['node_modules/lib'] },
      [`${app}generated/tsconfig.json`]: { include: ['.generated/**/*'] },
    })

    expect(
      await tscPlan(project, app, [
        'generated/.generated/index.ts',
        'vendor/node_modules/lib/index.ts',
      ]),
    ).toEqual([
      '▶ tsc -p generated/tsconfig.json --noEmit',
      '▶ tsc -p vendor/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, [
        'web/src/.cache/index.ts',
        'web/src/bower_components/index.ts',
        'web/src/node_modules/lib/index.ts',
      ]),
    ).toEqual([NOT_COVERED])
  })

  it('never matches a name ending in .min.js with *', async () => {
    const project = withFakeTsc(create, {
      [`${app}vendor/tsconfig.json`]: { ...ALLOW_JS, include: ['*'] },
      [`${app}plugins/tsconfig.json`]: { ...ALLOW_JS, include: ['jquery*'] },
    })

    expect(await tscPlan(project, app, ['plugins/jquery.ui.js', 'vendor/jquery.min.jsx'])).toEqual([
      '▶ tsc -p plugins/tsconfig.json --noEmit',
      '▶ tsc -p vendor/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['plugins/jquery.min.js', 'vendor/jquery.min.js'])).toEqual([
      NOT_COVERED,
    ])
  })

  it('keeps out only node_modules and .min.js spelled in their own case, as tsc does where case matters', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: { include: ['src'], ...ALLOW_JS },
    })

    expect(
      await tscPlan(project, app, ['web/src/Node_Modules/index.ts', 'web/src/vendor.Min.js']),
    ).toEqual(['▶ tsc -p web/tsconfig.json --noEmit'])
    expect(
      await tscPlan(project, app, ['web/src/node_modules/index.ts', 'web/src/vendor.min.js']),
    ).toEqual([NOT_COVERED])
  })

  it('ignores case in include but not in exclude', async () => {
    const project = withFakeTsc(create, {
      [`${app}include/tsconfig.json`]: { include: ['SRC'] },
      [`${app}exclude/tsconfig.json`]: { include: ['src'], exclude: ['src/Legacy'] },
    })

    expect(
      await tscPlan(project, app, ['exclude/src/legacy/index.ts', 'include/src/index.ts']),
    ).toEqual([
      '▶ tsc -p exclude/tsconfig.json --noEmit',
      '▶ tsc -p include/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['exclude/src/Legacy/index.ts'])).toEqual([NOT_COVERED])
  })

  it('excludes everything below an excluded folder or pattern', async () => {
    const project = withFakeTsc(create, {
      [`${app}web/tsconfig.json`]: {
        include: ['src'],
        exclude: ['src/legacy', 'src/**/*.test.ts', '**/__mocks__/**', 'src/v?'],
      },
    })

    expect(await tscPlan(project, app, ['web/src/deep/index.ts'])).toEqual([
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(
      await tscPlan(project, app, [
        'web/src/__mocks__/api/index.ts',
        'web/src/deep/index.test.ts',
        'web/src/index.test.ts',
        'web/src/legacy/deep/index.ts',
        'web/src/v1/index.ts',
      ]),
    ).toEqual([NOT_COVERED])
  })

  it('matches the other characters of a pattern as they are', async () => {
    const project = withFakeTsc(create, {
      [`${app}group/tsconfig.json`]: { include: ['app/(marketing)'] },
      [`${app}route/tsconfig.json`]: { include: ['app/[id]+.ts'] },
    })

    expect(
      await tscPlan(project, app, ['group/app/(marketing)/page.tsx', 'route/app/[id]+.ts']),
    ).toEqual(['▶ tsc -p group/tsconfig.json --noEmit', '▶ tsc -p route/tsconfig.json --noEmit'])
    expect(await tscPlan(project, app, ['group/app/marketing/page.tsx', 'route/app/i.ts'])).toEqual(
      [NOT_COVERED],
    )
  })
})
