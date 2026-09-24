import process from 'node:process'

import { argvBatches } from '../src/tool'

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
