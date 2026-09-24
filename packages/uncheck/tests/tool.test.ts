import Module from 'node:module'
import { join } from 'node:path'
import process from 'node:process'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { argvBatches, resolveBin } from '../src/tool'
import { fixture } from './fixture'

describe('argvBatches', () => {
  it('splits long file lists into batches every platform can spawn, keeping their order', () => {
    const files = Array.from({ length: 3000 }, (_, index) => `packages/app/src/feature ${index}.ts`)
    const batches = argvBatches(files)

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(files)

    for (const batch of batches) {
      const length = batch.reduce((total, file) => total + file.length + 3, 0)

      expect(length).toBeLessThanOrEqual(process.platform === 'win32' ? 30_000 : 65_536)
    }
  })

  it('keeps a short list in one batch', () => {
    expect(argvBatches(['a.ts', 'b.ts'])).toEqual([['a.ts', 'b.ts']])
    expect(argvBatches([])).toEqual([[]])
  })
})

describe('resolveBin', () => {
  it('asks the Yarn PnP resolver of each folder up the tree, then its node_modules', async () => {
    const dir = fixture(
      {
        'package.json': '{}',
        'packages/app/package.json': '{}',
        'packages/app/node_modules/oxfmt/package.json': { bin: 'oxfmt.js' },
        '.yarn/oxlint/package.json': { bin: { oxlint: 'bin.js' } },
      },
      [],
    )
    const loader = Module as unknown as {
      _resolveFilename: (
        request: string,
        parent: { filename: string },
        ...rest: unknown[]
      ) => string
    }
    const resolveFilename = loader._resolveFilename

    loader._resolveFilename = (request, parent, ...rest) =>
      request === 'oxlint/package.json' && parent.filename === join(dir, 'package.json')
        ? join(dir, '.yarn/oxlint/package.json')
        : Reflect.apply(resolveFilename, Module, [request, parent, ...rest])
    process.versions.pnp = '3'

    const resolve = (pkg: string) =>
      Effect.runPromise(
        resolveBin(pkg, join(dir, 'packages/app')).pipe(Effect.provide(NodeServices.layer)),
      )

    try {
      expect(await resolve('oxlint')).toEqual({
        name: 'oxlint',
        entry: join(dir, '.yarn/oxlint/bin.js'),
      })
      expect(await resolve('oxfmt')).toEqual({
        name: 'oxfmt',
        entry: join(dir, 'packages/app/node_modules/oxfmt/oxfmt.js'),
      })
      expect(await resolve('sherif')).toBeUndefined()
    } finally {
      loader._resolveFilename = resolveFilename
      delete process.versions.pnp
    }
  })
})
