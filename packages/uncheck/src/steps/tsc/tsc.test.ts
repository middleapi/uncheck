import type { TsProject } from './index'
import { join } from 'node:path'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { fixture } from '../../__tests__/fixture'
import { CircularProjectReferences, planTypecheck, selectTsconfigs } from './index'

type Graph = Record<string, string[]>

function projects(graph: Graph): ReadonlyMap<string, TsProject> {
  return new Map(Object.entries(graph).map(([config, references]) => [config, { path: config, references }]))
}

function plan(graph: Graph, entries: string[] = Object.keys(graph)) {
  return Effect.runSync(planTypecheck(entries, projects(graph)))
}

function planError(graph: Graph, entries: string[] = Object.keys(graph)) {
  return Effect.runSync(Effect.flip(planTypecheck(entries, projects(graph))))
}

describe('planTypecheck', () => {
  it('checks standalone projects with tsc -p', () => {
    expect(
      plan({
        '/repo/tsconfig.json': [],
        '/repo/packages/a/tsconfig.json': [],
      }),
    ).toEqual({
      build: [],
      check: ['/repo/packages/a/tsconfig.json', '/repo/tsconfig.json'],
    })
  })

  it('builds only the roots of the reference graph and leaves the rest to tsc -b', () => {
    expect(
      plan({
        '/repo/tsconfig.json': [],
        '/repo/packages/shared/tsconfig.json': [],
        '/repo/packages/client/tsconfig.json': ['/repo/packages/shared/tsconfig.json'],
        '/repo/packages/server/tsconfig.json': [
          '/repo/packages/client/tsconfig.json',
          '/repo/packages/shared/tsconfig.json',
        ],
        '/repo/packages/nest/tsconfig.json': ['/repo/packages/server/tsconfig.json'],
      }),
    ).toEqual({
      build: ['/repo/packages/nest/tsconfig.json'],
      check: ['/repo/tsconfig.json'],
    })
  })

  it('builds a solution-style root that references non-entry configs', () => {
    expect(
      plan(
        {
          '/app/tsconfig.json': ['/app/tsconfig.app.json', '/app/tsconfig.node.json'],
          '/app/tsconfig.app.json': [],
          '/app/tsconfig.node.json': [],
        },
        ['/app/tsconfig.json'],
      ),
    ).toEqual({
      build: ['/app/tsconfig.json'],
      check: [],
    })
  })

  it('keeps a root with references in build mode even when it is not composite', () => {
    expect(
      plan({
        '/repo/tsconfig.json': ['/repo/packages/a/tsconfig.json', '/repo/packages/b/tsconfig.json'],
        '/repo/packages/a/tsconfig.json': [],
        '/repo/packages/b/tsconfig.json': ['/repo/packages/a/tsconfig.json'],
      }),
    ).toEqual({
      build: ['/repo/tsconfig.json'],
      check: [],
    })
  })

  it('handles diamonds and multiple roots', () => {
    expect(
      plan({
        '/r/a/tsconfig.json': [],
        '/r/b/tsconfig.json': ['/r/a/tsconfig.json'],
        '/r/c/tsconfig.json': ['/r/a/tsconfig.json'],
        '/r/d/tsconfig.json': ['/r/b/tsconfig.json', '/r/c/tsconfig.json'],
        '/r/e/tsconfig.json': ['/r/a/tsconfig.json'],
      }),
    ).toEqual({
      build: ['/r/d/tsconfig.json', '/r/e/tsconfig.json'],
      check: [],
    })
  })

  it('fails on circular references instead of silently skipping them', () => {
    expect(
      planError({
        '/r/a/tsconfig.json': ['/r/b/tsconfig.json'],
        '/r/b/tsconfig.json': ['/r/a/tsconfig.json'],
        '/r/c/tsconfig.json': [],
      }),
    ).toEqual(new CircularProjectReferences({ projects: ['/r/a/tsconfig.json', '/r/b/tsconfig.json'] }))
  })

  it('reports only the cyclic part when a root also exists', () => {
    expect(
      planError({
        '/r/a/tsconfig.json': ['/r/b/tsconfig.json'],
        '/r/b/tsconfig.json': ['/r/c/tsconfig.json'],
        '/r/c/tsconfig.json': ['/r/b/tsconfig.json'],
      }).projects,
    ).toEqual(['/r/b/tsconfig.json', '/r/c/tsconfig.json'])
  })
})

describe('selectTsconfigs', () => {
  const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
  const lib = { extends: '../../tsconfig.base.json', include: ['src'], exclude: ['**/*.test.*'] }
  const entries = ['packages/a/tsconfig.json', 'packages/b/tsconfig.json', 'tsconfig.json']

  function monorepo() {
    return fixture(
      {
        'tsconfig.base.json': { compilerOptions: { strict: true } },
        'tsconfig.json': { include: ['scripts', '*', '*/*/src/**/*.test.*', '*/*/*'] },
        'packages/a/tsconfig.json': lib,
        'packages/b/tsconfig.json': lib,
      },
      [],
    )
  }

  function select(dir: string, files: string[]) {
    return Effect.runPromise(
      Effect.provide(
        selectTsconfigs(
          entries.map(entry => join(dir, entry)),
          files.map(file => join(dir, file)),
        ),
        layer,
      ),
    ).then(selected => selected.map(entry => entry.slice(dir.length + 1)))
  }

  it('selects only the projects whose inputs contain a file', async () => {
    const dir = monorepo()

    expect(await select(dir, ['packages/a/src/index.ts'])).toEqual(['packages/a/tsconfig.json'])
    // Tests are excluded by the package and picked up by the root instead.
    expect(await select(dir, ['packages/a/src/index.test.ts'])).toEqual(['tsconfig.json'])
    expect(await select(dir, ['packages/a/build.config.ts'])).toEqual(['tsconfig.json'])
    expect(await select(dir, ['scripts/release.ts'])).toEqual(['tsconfig.json'])
    expect(await select(dir, ['packages/a/src/index.ts', 'packages/b/src/index.ts'])).toEqual([
      'packages/a/tsconfig.json',
      'packages/b/tsconfig.json',
    ])
    expect(await select(dir, ['README.md', 'packages/a/styles.css'])).toEqual([])
  })
})
