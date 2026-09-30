import { createProject, eachLayout } from '../_shared/project'
import { CONFIG_DIR, FAKE_TYPESCRIPT, NOT_COVERED, coverage, plan, tscProject } from './tsc-plan'

const js = { compilerOptions: { allowJs: true } }

/** The consumers of `extends` specs whose `.js` sources a resolved preset puts in the project. */
function consumers(specs: Record<string, string | ReadonlyArray<string>>) {
  return Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      `consumers/${name}/tsconfig.json`,
      { extends: spec, include: ['src'] },
    ]),
  )
}

/** Plans the `.js` source of every consumer at once: the ones whose preset was resolved are planned. */
async function resolvedConsumers(
  project: Parameters<typeof plan>[0],
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const planned = await plan(
    project,
    names.map((name) => `consumers/${name}/src/index.js`),
  )

  return typeof planned === 'string'
    ? []
    : planned.map((line) => /^-p consumers\/(.+)\/tsconfig\.json --noEmit$/.exec(line)![1]!)
}

eachLayout('$layout', ({ layout }) => {
  it('inherits files, include, exclude and allowJs through extends, relative to the defining config', async () => {
    const project = tscProject(layout, {
      'node_modules/@shared/tsconfig/package.json': { tsconfig: './base.json' },
      'node_modules/@shared/tsconfig/base.json': {
        compilerOptions: { allowJs: true },
        include: [`${CONFIG_DIR}/lib`],
        exclude: [`${CONFIG_DIR}/lib/vendor`],
      },
      'tsconfig.lib.json': { extends: '@shared/tsconfig', include: ['src'] },
      'modules/a/tsconfig.json': { extends: ['../../tsconfig.lib', './tsconfig.files.json'] },
      'modules/a/tsconfig.files.json': {
        files: ['entry.ts'],
        compilerOptions: { allowJs: false },
      },
      'modules/b/tsconfig.json': { extends: '@shared/tsconfig' },
    })
    const a = ['-p modules/a/tsconfig.json --noEmit']
    const b = ['-p modules/b/tsconfig.json --noEmit']

    const plans = await Promise.all([
      // `files` comes from the last extends entry, `include` from tsconfig.lib.json and resolves next to it.
      plan(project, ['modules/a/entry.ts']),
      plan(project, ['src/index.ts']),
      plan(project, ['modules/a/src/index.ts']),
      plan(project, ['src/index.js']),
      // The base's `${configDir}` include and exclude point at the leaf config's folder.
      plan(project, ['modules/b/lib/util.ts']),
      plan(project, ['modules/b/lib/util.js']),
      plan(project, ['modules/b/lib/vendor/x.ts']),
      plan(project, ['modules/b/src/index.ts']),
    ])

    expect(plans).toEqual([a, a, NOT_COVERED, NOT_COVERED, b, b, NOT_COVERED, NOT_COVERED])
  })

  it('resolves extends through the exports of a package like tsc, and nothing they leave out', async () => {
    const project = tscProject(layout, {
      'node_modules/@shared/tsconfig/package.json': {
        exports: {
          './base': './presets/base.json',
          './lib': { import: './missing.json', require: './presets/lib.json' },
          './fallback': [{ import: './missing.json' }, null, './presets/base.json'],
          './gone': './presets/gone.json',
          './none': { import: './presets/base.json' },
          './*': './presets/*.json',
          './extra/*': './presets/extra/*.json',
          './e*': './presets/never.json',
          './extra/web/deeper/*': './presets/never.json',
          './other/*': './presets/never.json',
          './extra/*.jsonc': './presets/never.json',
          './package.json': './package.json',
        },
      },
      'node_modules/@shared/tsconfig/presets/base.json': js,
      'node_modules/@shared/tsconfig/presets/lib.json': js,
      'node_modules/@shared/tsconfig/presets/node.json': js,
      'node_modules/@shared/tsconfig/presets/extra/web.json': js,
      ...consumers({
        base: '@shared/tsconfig/base',
        // `import` is not a condition tsc uses for `extends`, so `require` is picked instead.
        lib: '@shared/tsconfig/lib',
        fallback: '@shared/tsconfig/fallback',
        // A pattern: the longest matching prefix wins.
        node: '@shared/tsconfig/node',
        web: '@shared/tsconfig/extra/web',
        // Exported, but the file is missing.
        gone: '@shared/tsconfig/gone',
        // Exported only for a condition tsc does not use.
        none: '@shared/tsconfig/none',
        // The file exists, but the package does not export it.
        hidden: '@shared/tsconfig/presets/base.json',
        // The package root is not exported at all.
        root: '@shared/tsconfig',
      }),
    })

    expect(
      await resolvedConsumers(project, [
        'base',
        'lib',
        'fallback',
        'node',
        'web',
        'gone',
        'none',
        'hidden',
        'root',
      ]),
    ).toEqual(['base', 'fallback', 'lib', 'node', 'web'])
  })

  it('reads every shape of exports: a string, an array and conditions for the package root', async () => {
    const project = tscProject(layout, {
      'node_modules/string/package.json': { exports: './base.json' },
      'node_modules/string/base.json': js,
      'node_modules/array/package.json': { exports: [7, './base.json'] },
      'node_modules/array/base.json': js,
      'node_modules/conditions/package.json': { exports: { types: './base.json' } },
      'node_modules/conditions/base.json': js,
      'node_modules/@scope/root/package.json': { exports: { '.': { node: './base.json' } } },
      'node_modules/@scope/root/base.json': js,
      ...consumers({
        string: 'string',
        array: 'array',
        conditions: 'conditions',
        scoped: '@scope/root',
        subpath: 'string/base.json',
      }),
    })

    expect(
      await resolvedConsumers(project, ['string', 'array', 'conditions', 'scoped', 'subpath']),
    ).toEqual(['array', 'conditions', 'scoped', 'string'])
  })

  it('resolves extends of a package without exports like tsc: the file, then .json, then its tsconfig', async () => {
    const project = tscProject(layout, {
      'node_modules/plain/presets/base.json': js,
      'node_modules/plain/tsconfig.json': js,
      'node_modules/plain/package.json': { name: 'plain' },
      'node_modules/named/package.json': { tsconfig: './config/strict.json' },
      'node_modules/named/config/strict.json': js,
      'node_modules/odd/package.json': { tsconfig: 42 },
      'node_modules/odd/tsconfig.json': js,
      'node_modules/bare/tsconfig.json': js,
      'node_modules/empty/package.json': { name: 'empty' },
      ...consumers({
        file: 'plain/presets/base.json',
        extension: 'plain/presets/base',
        folder: 'plain',
        named: 'named',
        odd: 'odd',
        bare: 'bare',
        empty: 'empty',
        missing: 'missing-package',
        relative: '../../node_modules/plain/presets/base',
        relativeMissing: './nowhere.json',
      }),
    })

    expect(
      await resolvedConsumers(project, [
        'file',
        'extension',
        'folder',
        'named',
        'odd',
        'bare',
        'empty',
        'missing',
        'relative',
        'relativeMissing',
      ]),
    ).toEqual(['bare', 'extension', 'file', 'folder', 'named', 'odd', 'relative'])
  })

  it('looks for an extended package in every node_modules up to the root', async () => {
    const project = tscProject(
      layout,
      {
        'modules/a/tsconfig.json': { extends: '@top/config', include: ['src'] },
        // A closer install of the package without the config is passed over.
        'modules/a/node_modules/@top/config/package.json': { name: '@top/config' },
      },
      { top: { 'node_modules/@top/config/tsconfig.json': js } },
    )

    expect(await plan(project, ['modules/a/src/index.js'])).toEqual([
      '-p modules/a/tsconfig.json --noEmit',
    ])
  })

  it('resolves an absolute extends path', async () => {
    const project = tscProject(layout, { 'shared/base.json': js })

    project.write({
      [project.inApp('tsconfig.json')]: {
        extends: project.path(project.inApp('shared/base')),
        include: ['src'],
      },
    })

    expect(await plan(project, ['src/index.js'])).toEqual(['-p tsconfig.json --noEmit'])
  })

  it('applies a base reached through two extends branches in both, like tsc, and stops at circular extends', async () => {
    const project = tscProject(layout, {
      'tsconfig.base.json': { include: [`${CONFIG_DIR}/lib`] },
      'tsconfig.b.json': { extends: './tsconfig.base.json', include: [`${CONFIG_DIR}/src`] },
      'tsconfig.c.json': { extends: './tsconfig.base.json' },
      'pkg/tsconfig.json': { extends: ['../tsconfig.b.json', '../tsconfig.c.json'] },
      'loop/tsconfig.json': { extends: './tsconfig.other.json' },
      'loop/tsconfig.other.json': { extends: './tsconfig.json', include: ['src'] },
      'weird/tsconfig.json': { extends: 42, include: ['src'] },
    })

    const plans = await Promise.all([
      plan(project, ['pkg/lib/index.ts']),
      plan(project, ['pkg/src/index.ts']),
      plan(project, ['loop/src/index.ts']),
      plan(project, ['weird/src/index.ts']),
    ])

    expect(plans).toEqual([
      ['-p pkg/tsconfig.json --noEmit'],
      NOT_COVERED,
      ['-p loop/tsconfig.json --noEmit'],
      ['-p weird/tsconfig.json --noEmit'],
    ])
  })

  it('selects the projects a changed shared config applies to', async () => {
    const project = tscProject(layout, {
      'tsconfig.base.json': { compilerOptions: { strict: true } },
      'tsconfig.json': { include: ['scripts'] },
      'modules/a/tsconfig.json': { extends: '../../tsconfig.base.json', include: ['src'] },
      'modules/b/tsconfig.json': { extends: '../../tsconfig', include: ['src'] },
    })
    const a = '-p modules/a/tsconfig.json --noEmit'
    const b = '-p modules/b/tsconfig.json --noEmit'

    expect(
      await Promise.all([
        plan(project, ['tsconfig.base.json']),
        plan(project, ['modules/a/tsconfig.json']),
        plan(project, ['tsconfig.json']),
        plan(project, ['tsconfig.base.json', 'scripts/release.ts']),
      ]),
    ).toEqual([[a], [a], [b, '-p tsconfig.json --noEmit'], [a, '-p tsconfig.json --noEmit']])
  })
})

describe('monorepo shared configs', () => {
  it('selects the projects a changed config applies to through a workspace package linked into node_modules', async () => {
    const project = createProject('monorepo', {
      tools: [],
      files: {
        ...FAKE_TYPESCRIPT,
        'tsconfig.base.json': { compilerOptions: { strict: true } },
        'tsconfig.json': { include: ['scripts'] },
        'packages/lib/strict.json': { compilerOptions: { noUncheckedIndexedAccess: true } },
        'packages/lib/tsconfig.json': { extends: '../../tsconfig.base.json', include: ['src'] },
        'packages/app/tsconfig.json': {
          extends: ['../../tsconfig.base.json', '@monorepo/lib/strict.json'],
          include: ['src'],
        },
      },
    })
    const app = '-p packages/app/tsconfig.json --noEmit'
    const lib = '-p packages/lib/tsconfig.json --noEmit'

    expect(
      await Promise.all([
        plan(project, ['tsconfig.base.json'], ''),
        plan(project, ['packages/lib/strict.json'], ''),
        plan(project, ['packages/lib/tsconfig.json'], ''),
        plan(project, ['tsconfig.json'], ''),
        plan(project, ['packages/lib/package.json'], ''),
        // Inside lib only lib's own projects are seen, and the shared config is not one of their inputs.
        plan(project, ['strict.json'], 'packages/lib'),
      ]),
    ).toEqual([[app, lib], [app], [lib], ['-p tsconfig.json --noEmit'], NOT_COVERED, NOT_COVERED])
  })

  it('checks a file of the app with the config it extends from another package', async () => {
    const project = createProject('monorepo', {
      tools: [],
      files: {
        ...FAKE_TYPESCRIPT,
        'packages/lib/tsconfig.base.json': js,
        'packages/app/tsconfig.json': { extends: '@monorepo/lib/tsconfig.base.json' },
      },
    })

    expect(await coverage(project, ['src/legacy.js'])).toEqual({ 'src/legacy.js': true })
  })
})
