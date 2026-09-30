import { createProject, eachLayout } from '../_shared/project'
import { CONFIG_DIR, FAKE_TYPESCRIPT, NOT_COVERED, plan, runPlan, tscProject } from './tsc-plan'

describe('monorepo project references', () => {
  it('checks the workspace packages side by side with tsc -p, and builds a reference graph with tsc -b', async () => {
    const project = createProject('monorepo', { tools: [], files: FAKE_TYPESCRIPT })

    const standalone = await runPlan(project, [], '')

    expect(standalone.result.code).toBe(0)
    expect(standalone.tsc).toEqual([
      '-p packages/app/tsconfig.json --noEmit',
      '-p packages/lib/tsconfig.json --noEmit',
    ])
    // The echoing tsc ran with exactly the planned arguments.
    expect(standalone.result.stdout).toContain('tsc -p packages/lib/tsconfig.json --noEmit\n')

    project.write({
      'packages/app/tsconfig.json': { include: ['src'], references: [{ path: '../lib' }] },
      'tsconfig.json': { include: ['scripts'] },
    })

    expect(await plan(project, [], '')).toEqual([
      '-b packages/app/tsconfig.json',
      '-p tsconfig.json --noEmit',
    ])
    // Inside the app the graph is found through the reference that leaves the package.
    expect(await plan(project, [])).toEqual(['-b tsconfig.json'])
    // A change to lib rebuilds the app that references it; the root project does not contain it.
    expect(await plan(project, ['packages/lib/src/index.ts'], '')).toEqual([
      '-b packages/app/tsconfig.json',
    ])
    expect(await plan(project, ['scripts/release.ts'], '')).toEqual(['-p tsconfig.json --noEmit'])
  })
})

eachLayout('$layout', ({ layout }) => {
  it('checks standalone projects with tsc -p, in path order', async () => {
    const project = tscProject(layout, { 'tsconfig.json': {}, 'scripts/tsconfig.json': {} })

    expect(await plan(project)).toEqual([
      '-p scripts/tsconfig.json --noEmit',
      '-p tsconfig.json --noEmit',
    ])
  })

  it('builds only the roots of the reference graph and leaves the rest to tsc -b', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {},
      'modules/shared/tsconfig.json': {},
      'modules/client/tsconfig.json': { references: [{ path: '../shared' }] },
      'modules/server/tsconfig.json': {
        references: [{ path: '../client' }, { path: '../shared' }],
      },
      'modules/nest/tsconfig.json': { references: [{ path: '../server/tsconfig.json' }] },
    })

    expect(await plan(project)).toEqual([
      '-b modules/nest/tsconfig.json',
      '-p tsconfig.json --noEmit',
    ])
  })

  it('builds a solution-style root that references configs not named tsconfig.json', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      },
      'tsconfig.app.json': { include: ['src'] },
      'tsconfig.node.json': { include: ['vite.config.ts'] },
    })

    expect(await plan(project)).toEqual(['-b tsconfig.json'])
    // The referenced configs are selected whatever their name, and built through the root.
    expect(await plan(project, ['src/main.ts'])).toEqual(['-b tsconfig.json'])
    expect(await plan(project, ['vite.config.ts'])).toEqual(['-b tsconfig.json'])
    expect(await plan(project, ['tsconfig.app.json'])).toEqual(['-b tsconfig.json'])
    expect(await plan(project, ['scripts/release.ts'])).toBe(NOT_COVERED)
  })

  it('keeps a root with references in build mode even when it is not composite', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': { references: [{ path: './modules/a' }, { path: './modules/b' }] },
      'modules/a/tsconfig.json': {},
      'modules/b/tsconfig.json': { references: [{ path: '../a' }] },
    })

    expect(await plan(project)).toEqual(['-b tsconfig.json'])
  })

  it('handles diamonds and multiple roots', async () => {
    const project = tscProject(layout, {
      'a/tsconfig.json': {},
      'b/tsconfig.json': { references: [{ path: '../a' }] },
      'c/tsconfig.json': { references: [{ path: '../a' }] },
      'd/tsconfig.json': { references: [{ path: '../b' }, { path: '../c' }] },
      'e/tsconfig.json': { references: [{ path: '../a' }] },
    })

    expect(await plan(project)).toEqual(['-b d/tsconfig.json e/tsconfig.json'])
  })

  it('builds every root that depends on a selected project, and no other', async () => {
    const project = tscProject(layout, {
      'lib/tsconfig.json': {},
      'app/tsconfig.json': { references: [{ path: '../lib' }] },
      'web/tsconfig.json': { references: [{ path: '../lib' }] },
      'core/tsconfig.json': {},
      'cli/tsconfig.json': { references: [{ path: '../core' }] },
      'solo/tsconfig.json': {},
    })

    const [lib, app, mixed] = await Promise.all([
      plan(project, ['lib/src/index.ts']),
      plan(project, ['app/src/index.ts']),
      plan(project, ['core/src/index.ts', 'solo/src/index.ts', 'README.md']),
    ])

    expect(lib).toEqual(['-b app/tsconfig.json web/tsconfig.json'])
    expect(app).toEqual(['-b app/tsconfig.json'])
    expect(mixed).toEqual(['-b cli/tsconfig.json', '-p solo/tsconfig.json --noEmit'])
  })

  it('fails on circular references instead of silently skipping them, whatever the files', async () => {
    const project = tscProject(layout, {
      'a/tsconfig.json': { references: [{ path: '../b' }] },
      'b/tsconfig.json': { references: [{ path: '../a' }] },
      'c/tsconfig.json': {},
    })
    const cycle = 'circular project references between a/tsconfig.json, b/tsconfig.json'

    const [all, inCycle, outside] = await Promise.all([
      runPlan(project),
      plan(project, ['a/src/index.ts']),
      plan(project, ['c/src/index.ts']),
    ])

    expect(all.result.code).toBe(1)
    expect(all.result.stdout).toContain(`✘ tsc ${cycle}\n`)
    expect(all.result.stdout).not.toContain('▶ tsc')
    expect(inCycle).toBe(cycle)
    expect(outside).toBe(cycle)
  })

  it('reports only the cyclic part when a root also exists', async () => {
    const project = tscProject(layout, {
      'a/tsconfig.json': { references: [{ path: '../b' }] },
      'b/tsconfig.json': { references: [{ path: '../c' }] },
      'c/tsconfig.json': { references: [{ path: '../b' }] },
    })

    expect(await plan(project)).toBe(
      'circular project references between b/tsconfig.json, c/tsconfig.json',
    )
  })

  it('follows references as written, leaving the configDir token alone like tsc', async () => {
    const project = tscProject(layout, {
      'app/tsconfig.json': { references: [{ path: `${CONFIG_DIR}/../lib` }] },
      'app/lib/tsconfig.json': {},
      'lib/tsconfig.json': {},
    })

    expect(await plan(project)).toEqual(['-b app/tsconfig.json', '-p lib/tsconfig.json --noEmit'])
  })

  it('reads backslashes in tsconfig paths as separators, like tsc', async () => {
    const project = tscProject(layout, {
      'tsconfig.base.json': { compilerOptions: { allowJs: true }, include: [`${CONFIG_DIR}/src`] },
      'tsconfig.json': { files: [], references: [{ path: '.\\modules\\b' }] },
      'modules/a/tsconfig.json': { extends: '..\\..\\tsconfig.base.json' },
      'modules/b/tsconfig.json': {
        extends: '..\\..\\tsconfig.base.json',
        references: [{ path: '..\\a' }],
      },
      'c/tsconfig.json': { include: ['.\\src', '..\\shared'] },
    })

    const [all, js, outside, globs] = await Promise.all([
      plan(project),
      plan(project, ['modules/a/src/index.js']),
      plan(project, ['modules/a/scripts/build.ts']),
      plan(project, ['c/src/x.ts', 'shared/y.ts']),
    ])

    expect(all).toEqual(['-b tsconfig.json', '-p c/tsconfig.json --noEmit'])
    expect(js).toEqual(['-b tsconfig.json'])
    expect(outside).toBe(NOT_COVERED)
    expect(globs).toEqual(['-p c/tsconfig.json --noEmit'])
  })

  it('leaves a referenced config that does not exist to tsc -b, and never selects it', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': { include: ['src'], references: [{ path: './modules/gone' }] },
    })

    const [all, source, gone] = await Promise.all([
      plan(project),
      plan(project, ['src/index.ts']),
      plan(project, ['modules/gone/index.ts']),
    ])

    expect(all).toEqual(['-b tsconfig.json'])
    expect(source).toEqual(['-b tsconfig.json'])
    expect(gone).toBe(NOT_COVERED)
  })

  it('ignores references it cannot read, leaving them for tsc to report', async () => {
    const project = tscProject(layout, {
      // A reference that is not an object or has no path is no reference.
      'a/tsconfig.json': { references: [42, { path: 7 }, null, { prepend: true }] },
      'b/tsconfig.json': { references: { path: '../a' } },
      // A reference to a folder named like a config reads as an empty config.
      'c/tsconfig.json': { references: [{ path: './folder.json' }] },
      'c/folder.json/readme.md': 'not a config\n',
      'd/tsconfig.json':
        '{ "references": [{ "path": "../a" }], // trailing comma and comments\n}\n',
      'e/tsconfig.json': '["not", "an", "object"]\n',
      'f/tsconfig.json': '{ this is not json',
    })

    expect(await plan(project)).toEqual([
      '-b c/tsconfig.json d/tsconfig.json',
      '-p b/tsconfig.json --noEmit',
      '-p e/tsconfig.json --noEmit',
      '-p f/tsconfig.json --noEmit',
    ])
  })
})
