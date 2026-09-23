import type { OxlintConfig } from 'oxlint'

/**
 * The oxlint preset of the middleapi projects: oxlint's defaults, at their own severities, plus the
 * few rules that catch real bugs or keep code portable. Style is left to oxfmt.
 *
 * ```ts
 * import { defineConfig } from 'oxlint'
 * import { middleapi } from 'uncheck/oxlint'
 *
 * export default defineConfig({ extends: [middleapi] })
 * ```
 */
export const middleapi: OxlintConfig = {
  plugins: ['typescript', 'unicorn', 'oxc', 'import', 'node', 'eslint'],
  rules: {
    'eqeqeq': 'error',
    'guard-for-in': 'error',
    'no-constructor-return': 'error',
    'no-extend-native': 'error',
    'no-new-func': 'error',
    'no-prototype-builtins': 'error',
    'no-self-compare': 'error',
    'no-template-curly-in-string': 'error',
    'no-throw-literal': 'error',
    'no-unmodified-loop-condition': 'error',
    'prefer-promise-reject-errors': 'error',
    'preserve-caught-error': 'error',
    'oxc/misrefactored-assign-op': 'error',
    'oxc/no-accumulating-spread': 'error',
    'typescript/no-confusing-non-null-assertion': 'error',
    'unicorn/no-accessor-recursion': 'error',
    'unicorn/no-array-fill-with-reference-type': 'error',
    'unicorn/no-negation-in-equality-check': 'error',

    'no-console': ['error', { allow: ['warn', 'error'] }],
    'no-var': 'error',
    'prefer-const': 'error',

    'typescript/consistent-type-imports': 'error',
    'typescript/no-import-type-side-effects': 'error',
    'oxc/no-const-enum': 'error',
    'unicorn/prefer-global-this': 'error',
    'unicorn/prefer-node-protocol': 'error',

    'import/no-duplicates': 'warn',
  },
}
