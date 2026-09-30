import codspeedPlugin from '@codspeed/vitest-plugin'
import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig(() => ({
  plugins: [codspeedPlugin()],
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    exclude: [...defaultExclude, '**/.claude/**'],
    testTimeout: 120_000,
    coverage: {
      include: ['packages/*/src/**'],
      exclude: ['**.test-d.*', '**.test.*', '**/*.bench.ts'],
      autoAttachSubprocess: true,
      thresholds: { 100: true },
    },
    benchmark: {
      include: ['**/*.bench.ts'],
      exclude: [...defaultExclude, '**/.claude/**'],
    },
  },
}))
