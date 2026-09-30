import codspeedPlugin from '@codspeed/vitest-plugin'
import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig(() => ({
  plugins: [codspeedPlugin()],
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    exclude: [...defaultExclude, '**/.claude/**', '**/tests/fixtures/**'],
    // Every test drives the CLI in its own processes, on real repositories.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    benchmark: {
      include: ['**/*.bench.ts'],
      exclude: [...defaultExclude, '**/.claude/**'],
    },
  },
}))
