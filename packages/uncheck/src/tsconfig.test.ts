import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { coversDirectory, includesFile, loadTsconfigInputs } from './tsconfig'
import { selectTsconfigs } from './typecheck'

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const fixtures: string[] = []

afterAll(() => {
  for (const dir of fixtures) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'uncheck-tsconfig-'))
  fixtures.push(dir)

  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true })
    writeFileSync(join(dir, relative), typeof content === 'string' ? content : JSON.stringify(content))
  }

  return dir
}

function inputs(configPath: string) {
  return Effect.runPromise(Effect.provide(loadTsconfigInputs(configPath), layer))
}

function select(dir: string, entries: string[], paths: string[]) {
  return Effect.runPromise(
    Effect.provide(
      selectTsconfigs(
        entries.map(entry => join(dir, entry)),
        paths,
        dir,
      ),
      layer,
    ),
  ).then(selected => selected.map(entry => entry.slice(dir.length + 1)))
}

describe('loadTsconfigInputs', () => {
  it('matches files like tsc: include folders, wildcards, extensions and default excludes', async () => {
    const dir = fixture({
      'tsconfig.json': { include: ['src', 'scripts/*.ts', 'config/*.json', '*/*/*'], exclude: ['src/legacy'] },
    })

    const project = await inputs(join(dir, 'tsconfig.json'))
    const has = (file: string) => includesFile(project, join(dir, file))

    expect(has('src/index.ts')).toBe(true)
    expect(has('src/deep/nested/component.tsx')).toBe(true)
    expect(has('src/types.d.ts')).toBe(true)
    expect(has('src/index.js')).toBe(false)
    expect(has('src/README.md')).toBe(false)
    expect(has('src/.hidden/index.ts')).toBe(false)
    expect(has('src/node_modules/dep/index.ts')).toBe(false)
    expect(has('src/legacy/old.ts')).toBe(false)
    expect(has('scripts/build.ts')).toBe(true)
    expect(has('scripts/nested/deep/build.ts')).toBe(false)
    expect(has('config/app.json')).toBe(true)
    expect(has('src/data.json')).toBe(false)
    expect(has('packages/app/build.config.ts')).toBe(true)
    expect(has('packages/app/src/index.ts')).toBe(false)
    expect(has('node_modules/dep/index.ts')).toBe(false)
  })

  it('falls back to everything, minus node_modules and outDir, when nothing is configured', async () => {
    const dir = fixture({ 'tsconfig.json': { compilerOptions: { outDir: 'dist' } } })

    const project = await inputs(join(dir, 'tsconfig.json'))
    const has = (file: string) => includesFile(project, join(dir, file))

    expect(has('index.ts')).toBe(true)
    expect(has('deep/index.ts')).toBe(true)
    expect(has('dist/index.d.ts')).toBe(false)
    expect(has('node_modules/dep/index.d.ts')).toBe(false)
    expect(has('.git/hooks/pre-commit.ts')).toBe(false)
  })

  it('inherits files, include, exclude and allowJs through extends, relative to the defining config', async () => {
    const dir = fixture({
      'node_modules/@shared/tsconfig/package.json': { tsconfig: './base.json' },
      'node_modules/@shared/tsconfig/base.json': {
        compilerOptions: { allowJs: true },
        include: ['${configDir}/lib'],
        exclude: ['${configDir}/lib/vendor'],
      },
      'tsconfig.lib.json': { extends: '@shared/tsconfig', include: ['src'] },
      'packages/a/tsconfig.json': { extends: ['../../tsconfig.lib', './tsconfig.files.json'] },
      'packages/a/tsconfig.files.json': { files: ['entry.ts'], compilerOptions: { allowJs: false } },
      'packages/b/tsconfig.json': { extends: '@shared/tsconfig' },
    })

    const a = await inputs(join(dir, 'packages/a/tsconfig.json'))
    const b = await inputs(join(dir, 'packages/b/tsconfig.json'))

    // `files` comes from the last extends entry, `include` from tsconfig.lib.json and resolves next to it.
    expect(includesFile(a, join(dir, 'packages/a/entry.ts'))).toBe(true)
    expect(includesFile(a, join(dir, 'src/index.ts'))).toBe(true)
    expect(includesFile(a, join(dir, 'packages/a/src/index.ts'))).toBe(false)
    expect(includesFile(a, join(dir, 'src/index.js'))).toBe(false)
    // `exclude` is still the base's, with `${configDir}` pointing at the leaf.
    expect(includesFile(a, join(dir, 'packages/a/lib/vendor/x.ts'))).toBe(false)

    expect(includesFile(b, join(dir, 'packages/b/lib/util.ts'))).toBe(true)
    expect(includesFile(b, join(dir, 'packages/b/lib/util.js'))).toBe(true)
    expect(includesFile(b, join(dir, 'packages/b/lib/vendor/x.ts'))).toBe(false)
    expect(includesFile(b, join(dir, 'packages/b/src/index.ts'))).toBe(false)
  })

  it('tells whether a directory can hold inputs', async () => {
    const dir = fixture({ 'tsconfig.json': { include: ['src', 'tests/**/*.spec.ts'], exclude: ['src/generated'] } })

    const project = await inputs(join(dir, 'tsconfig.json'))
    const covers = (folder: string) => coversDirectory(project, join(dir, folder))

    expect(covers('src')).toBe(true)
    expect(covers('src/components')).toBe(true)
    expect(covers('tests/unit')).toBe(true)
    expect(covers('.')).toBe(true)
    expect(covers('docs')).toBe(false)
    expect(covers('src/generated')).toBe(false)
    expect(covers('src/generated/api')).toBe(false)
  })
})

describe('selectTsconfigs', () => {
  const root = {
    include: ['scripts', '*', '*/*/src/**/*.test.*', '*/*/*'],
  }

  const lib = { extends: '../../tsconfig.base.json', include: ['src'], exclude: ['**/*.test.*'] }

  function monorepo() {
    return fixture({
      'tsconfig.base.json': { compilerOptions: { strict: true } },
      'tsconfig.json': root,
      'packages/a/tsconfig.json': lib,
      'packages/b/tsconfig.json': lib,
    })
  }

  const entries = ['packages/a/tsconfig.json', 'packages/b/tsconfig.json', 'tsconfig.json']

  it('returns every project when no paths are given', async () => {
    const dir = monorepo()

    expect(await select(dir, entries, [])).toEqual(entries)
  })

  it('selects only the projects whose inputs contain a file', async () => {
    const dir = monorepo()

    expect(await select(dir, entries, ['packages/a/src/index.ts'])).toEqual(['packages/a/tsconfig.json'])
    // Tests are excluded by the package and picked up by the root instead.
    expect(await select(dir, entries, ['packages/a/src/index.test.ts'])).toEqual(['tsconfig.json'])
    expect(await select(dir, entries, ['packages/a/build.config.ts'])).toEqual(['tsconfig.json'])
    expect(await select(dir, entries, ['scripts/release.ts'])).toEqual(['tsconfig.json'])
    expect(await select(dir, entries, ['packages/a/src/index.ts', 'packages/b/src/index.ts'])).toEqual([
      'packages/a/tsconfig.json',
      'packages/b/tsconfig.json',
    ])
  })

  it('ignores negations and files tsc would never check', async () => {
    const dir = monorepo()

    expect(await select(dir, entries, ['README.md', 'packages/a/styles.css'])).toEqual([])
    expect(await select(dir, entries, ['**/README.md', 'packages/**/*.css'])).toEqual([])
    expect(await select(dir, entries, ['!**/*.test.ts'])).toEqual([])
    expect(await select(dir, entries, ['packages/a/src/index.ts', 'docs/notes.md'])).toEqual([
      'packages/a/tsconfig.json',
    ])
  })

  it('selects the projects whose inputs overlap a directory or glob', async () => {
    const dir = monorepo()

    expect(await select(dir, entries, ['packages/b/src'])).toEqual(['packages/b/tsconfig.json', 'tsconfig.json'])
    expect(await select(dir, entries, ['packages/a/src/**/*.ts'])).toEqual([
      'packages/a/tsconfig.json',
      'tsconfig.json',
    ])
    expect(await select(dir, entries, ['docs'])).toEqual(['tsconfig.json'])
    expect(await select(dir, entries, ['**/*.ts'])).toEqual(entries)
  })
})
