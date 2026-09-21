import { join } from 'node:path'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { fixture } from '../../__tests__/fixture'
import { includesFile, loadTsconfigInputs } from './tsconfig'

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

function inputs(configPath: string) {
  return Effect.runPromise(Effect.provide(loadTsconfigInputs(configPath), layer))
}

describe('loadTsconfigInputs', () => {
  it('matches files like tsc: include folders, wildcards, extensions and default excludes', async () => {
    const dir = fixture(
      { 'tsconfig.json': { include: ['src', 'scripts/*.ts', 'config/*.json', '*/*/*'], exclude: ['src/legacy'] } },
      [],
    )

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
    const dir = fixture({ 'tsconfig.json': { compilerOptions: { outDir: 'dist' } } }, [])

    const project = await inputs(join(dir, 'tsconfig.json'))
    const has = (file: string) => includesFile(project, join(dir, file))

    expect(has('index.ts')).toBe(true)
    expect(has('deep/index.ts')).toBe(true)
    expect(has('dist/index.d.ts')).toBe(false)
    expect(has('node_modules/dep/index.d.ts')).toBe(false)
    expect(has('.git/hooks/pre-commit.ts')).toBe(false)
  })

  it('inherits files, include, exclude and allowJs through extends, relative to the defining config', async () => {
    const dir = fixture(
      {
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
      },
      [],
    )

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
})
