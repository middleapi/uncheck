import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { tsc } from '../src/checks/tsc'
import { listProjectFiles } from '../src/files'
import { fixture } from './fixture'

/** Plans the tsc check in `dir`: the tsc command lines it would run, or the reason it does not run. */
function plan(dir: string, files?: string[]): Promise<string[] | string> {
  return Effect.runPromise(
    Effect.provide(
      tsc.plan({ cwd: dir, fix: false, files, projectFiles: listProjectFiles(dir) }).pipe(
        Effect.map((commands) => commands.map((command) => command.args.join(' '))),
        Effect.catchTag('NothingToCheck', (error) => Effect.succeed(error.reason)),
        Effect.catchTag('CannotCheck', (error) => Effect.succeed(error.reason)),
      ),
      NodeServices.layer,
    ),
  )
}

const NOT_COVERED = 'no tsconfig.json covers the given files'

describe('tsc project references', () => {
  it('checks standalone projects with tsc -p', async () => {
    const dir = fixture({ 'tsconfig.json': {}, 'packages/a/tsconfig.json': {} })

    expect(await plan(dir)).toEqual([
      '-p packages/a/tsconfig.json --noEmit',
      '-p tsconfig.json --noEmit',
    ])
  })

  it('builds only the roots of the reference graph and leaves the rest to tsc -b', async () => {
    const dir = fixture({
      'tsconfig.json': {},
      'packages/shared/tsconfig.json': {},
      'packages/client/tsconfig.json': { references: [{ path: '../shared' }] },
      'packages/server/tsconfig.json': {
        references: [{ path: '../client' }, { path: '../shared' }],
      },
      'packages/nest/tsconfig.json': { references: [{ path: '../server/tsconfig.json' }] },
    })

    expect(await plan(dir)).toEqual(['-b packages/nest/tsconfig.json', '-p tsconfig.json --noEmit'])
  })

  it('builds a solution-style root that references configs not named tsconfig.json', async () => {
    const dir = fixture({
      'tsconfig.json': {
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      },
      'tsconfig.app.json': {},
      'tsconfig.node.json': {},
    })

    expect(await plan(dir)).toEqual(['-b tsconfig.json'])
  })

  it('keeps a root with references in build mode even when it is not composite', async () => {
    const dir = fixture({
      'tsconfig.json': { references: [{ path: './packages/a' }, { path: './packages/b' }] },
      'packages/a/tsconfig.json': {},
      'packages/b/tsconfig.json': { references: [{ path: '../a' }] },
    })

    expect(await plan(dir)).toEqual(['-b tsconfig.json'])
  })

  it('handles diamonds and multiple roots', async () => {
    const dir = fixture({
      'a/tsconfig.json': {},
      'b/tsconfig.json': { references: [{ path: '../a' }] },
      'c/tsconfig.json': { references: [{ path: '../a' }] },
      'd/tsconfig.json': { references: [{ path: '../b' }, { path: '../c' }] },
      'e/tsconfig.json': { references: [{ path: '../a' }] },
    })

    expect(await plan(dir)).toEqual(['-b d/tsconfig.json e/tsconfig.json'])
  })

  it('fails on circular references instead of silently skipping them', async () => {
    const dir = fixture({
      'a/tsconfig.json': { references: [{ path: '../b' }] },
      'b/tsconfig.json': { references: [{ path: '../a' }] },
      'c/tsconfig.json': {},
    })

    expect(await plan(dir)).toBe(
      'circular project references between a/tsconfig.json, b/tsconfig.json',
    )
  })

  it('reports only the cyclic part when a root also exists', async () => {
    const dir = fixture({
      'a/tsconfig.json': { references: [{ path: '../b' }] },
      'b/tsconfig.json': { references: [{ path: '../c' }] },
      'c/tsconfig.json': { references: [{ path: '../b' }] },
    })

    expect(await plan(dir)).toBe(
      'circular project references between b/tsconfig.json, c/tsconfig.json',
    )
  })
})

describe('tsc project selection', () => {
  it('matches files like tsc: include folders, wildcards, extensions and default excludes', async () => {
    const dir = fixture({
      'tsconfig.json': {
        include: ['src', 'scripts/*.ts', 'config/*.json', '*/*/*'],
        exclude: ['src/legacy'],
      },
    })
    const covers = (file: string) => plan(dir, [file]).then(Array.isArray)

    expect(await covers('src/index.ts')).toBe(true)
    expect(await covers('src/deep/nested/component.tsx')).toBe(true)
    expect(await covers('src/types.d.ts')).toBe(true)
    expect(await covers('src/index.js')).toBe(false)
    expect(await covers('src/README.md')).toBe(false)
    expect(await covers('src/.hidden/index.ts')).toBe(false)
    expect(await covers('src/node_modules/dep/index.ts')).toBe(false)
    expect(await covers('src/legacy/old.ts')).toBe(false)
    expect(await covers('scripts/build.ts')).toBe(true)
    expect(await covers('scripts/nested/deep/build.ts')).toBe(false)
    expect(await covers('config/app.json')).toBe(true)
    expect(await covers('src/data.json')).toBe(false)
    expect(await covers('packages/app/build.config.ts')).toBe(true)
    expect(await covers('packages/app/src/index.ts')).toBe(false)
    expect(await covers('node_modules/dep/index.ts')).toBe(false)
  })

  it('falls back to everything, minus node_modules and outDir, when nothing is configured', async () => {
    const dir = fixture({ 'tsconfig.json': { compilerOptions: { outDir: 'dist' } } })
    const covers = (file: string) => plan(dir, [file]).then(Array.isArray)

    expect(await covers('index.ts')).toBe(true)
    expect(await covers('deep/index.ts')).toBe(true)
    expect(await covers('dist/index.d.ts')).toBe(false)
    expect(await covers('node_modules/dep/index.d.ts')).toBe(false)
    expect(await covers('.git/hooks/pre-commit.ts')).toBe(false)
  })

  it('inherits files, include, exclude and allowJs through extends, relative to the defining config', async () => {
    const dir = fixture({
      'node_modules/@shared/tsconfig/package.json': { tsconfig: './base.json' },
      'node_modules/@shared/tsconfig/base.json': {
        compilerOptions: { allowJs: true },
        // oxlint-disable-next-line no-template-curly-in-string
        include: ['${configDir}/lib'],
        // oxlint-disable-next-line no-template-curly-in-string
        exclude: ['${configDir}/lib/vendor'],
      },
      'tsconfig.lib.json': { extends: '@shared/tsconfig', include: ['src'] },
      'packages/a/tsconfig.json': { extends: ['../../tsconfig.lib', './tsconfig.files.json'] },
      'packages/a/tsconfig.files.json': {
        files: ['entry.ts'],
        compilerOptions: { allowJs: false },
      },
      'packages/b/tsconfig.json': { extends: '@shared/tsconfig' },
    })
    const a = ['-p packages/a/tsconfig.json --noEmit']
    const b = ['-p packages/b/tsconfig.json --noEmit']

    // `files` comes from the last extends entry, `include` from tsconfig.lib.json and resolves next to it.
    expect(await plan(dir, ['packages/a/entry.ts'])).toEqual(a)
    expect(await plan(dir, ['src/index.ts'])).toEqual(a)
    expect(await plan(dir, ['packages/a/src/index.ts'])).toBe(NOT_COVERED)
    expect(await plan(dir, ['src/index.js'])).toBe(NOT_COVERED)

    // The base's `${configDir}` include and exclude point at the leaf config's folder.
    expect(await plan(dir, ['packages/b/lib/util.ts'])).toEqual(b)
    expect(await plan(dir, ['packages/b/lib/util.js'])).toEqual(b)
    expect(await plan(dir, ['packages/b/lib/vendor/x.ts'])).toBe(NOT_COVERED)
    expect(await plan(dir, ['packages/b/src/index.ts'])).toBe(NOT_COVERED)
  })

  it('resolves extends through the exports of a package like tsc, and nothing they leave out', async () => {
    const js = { compilerOptions: { allowJs: true } }
    const dir = fixture({
      'node_modules/@shared/tsconfig/package.json': {
        exports: {
          './base': './presets/base.json',
          './lib': { import: './missing.json', require: './presets/lib.json' },
          './extra/*': './presets/extra/*.json',
        },
      },
      'node_modules/@shared/tsconfig/presets/base.json': js,
      'node_modules/@shared/tsconfig/presets/lib.json': js,
      'node_modules/@shared/tsconfig/presets/extra/web.json': js,
      'packages/a/tsconfig.json': { extends: '@shared/tsconfig/base', include: ['src'] },
      'packages/b/tsconfig.json': { extends: '@shared/tsconfig/lib', include: ['src'] },
      'packages/c/tsconfig.json': { extends: '@shared/tsconfig/extra/web', include: ['src'] },
      'packages/d/tsconfig.json': {
        extends: '@shared/tsconfig/presets/base.json',
        include: ['src'],
      },
    })

    // `allowJs` from the preset puts `.js` files in the project, so it was resolved.
    expect(await plan(dir, ['packages/a/src/index.js'])).toEqual([
      '-p packages/a/tsconfig.json --noEmit',
    ])
    // `import` is not a condition tsc uses for `extends`, so `require` is picked instead.
    expect(await plan(dir, ['packages/b/src/index.js'])).toEqual([
      '-p packages/b/tsconfig.json --noEmit',
    ])
    expect(await plan(dir, ['packages/c/src/index.js'])).toEqual([
      '-p packages/c/tsconfig.json --noEmit',
    ])
    // The file exists, but the package does not export it.
    expect(await plan(dir, ['packages/d/src/index.js'])).toBe(NOT_COVERED)
  })

  it('selects only the projects whose inputs contain a given file', async () => {
    const lib = { extends: '../../tsconfig.base.json', include: ['src'], exclude: ['**/*.test.*'] }
    const dir = fixture({
      'tsconfig.base.json': { compilerOptions: { strict: true } },
      'tsconfig.json': { include: ['scripts', '*', '*/*/src/**/*.test.*', '*/*/*'] },
      'packages/a/tsconfig.json': lib,
      'packages/b/tsconfig.json': lib,
    })

    expect(await plan(dir, ['packages/a/src/index.ts'])).toEqual([
      '-p packages/a/tsconfig.json --noEmit',
    ])
    // Tests are excluded by the package and picked up by the root instead.
    expect(await plan(dir, ['packages/a/src/index.test.ts'])).toEqual(['-p tsconfig.json --noEmit'])
    expect(await plan(dir, ['packages/a/build.config.ts'])).toEqual(['-p tsconfig.json --noEmit'])
    expect(await plan(dir, ['scripts/release.ts'])).toEqual(['-p tsconfig.json --noEmit'])
    expect(await plan(dir, ['packages/a/src/index.ts', 'packages/b/src/index.ts'])).toEqual([
      '-p packages/a/tsconfig.json --noEmit',
      '-p packages/b/tsconfig.json --noEmit',
    ])
    expect(await plan(dir, ['README.md', 'packages/a/styles.css'])).toBe(NOT_COVERED)
  })
})
