import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  rules: {
    'yaml/sort-keys': 'off',
    'pnpm/json-enforce-catalog': 'off',
    'pnpm/yaml-enforce-settings': 'off',
    'ts/method-signature-style': 'off',
    'guard-for-in': 'error',
  },
}, {
  files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test-d.ts', '**/*.test-d.tsx', 'playgrounds/**', 'packages/*/playground/**'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'antfu/no-top-level-await': 'off',
    'no-alert': 'off',
    'ban/ban': 'off',
    'no-restricted-globals': 'off',
    'no-console': 'off',
  },
})
