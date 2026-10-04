import {
  FULL_OXFMT,
  FULL_OXFMT_FIX,
  FULL_OXLINT,
  FULL_OXLINT_FIX,
  LAYOUTS,
  report,
} from '../utils/project'
import { layoutChecks } from './utils'

const PRESET_CONFIGS = {
  '.oxlintrc.json': null,
  'oxlint.config.ts': `import { defineConfig } from 'oxlint'
import { middleapi } from 'uncheck/oxlint'

export default defineConfig({
  extends: [middleapi],
})
`,
  'oxfmt.config.ts': `import { defineConfig } from 'oxfmt'
import { middleapi } from 'uncheck/oxfmt'

export default defineConfig({
  ...middleapi,
})
`,
}

const BUG_RULES = [
  'eslint(preserve-caught-error)',
  'oxc(misrefactored-assign-op)',
  'oxc(no-accumulating-spread)',
  'typescript(no-confusing-non-null-assertion)',
  'unicorn(no-accessor-recursion)',
  'unicorn(no-array-fill-with-reference-type)',
  'unicorn(no-negation-in-equality-check)',
  'eslint(no-constructor-return)',
]

const USE_BEFORE_FIX = `import { c } from "./other.ts";
import { a } from "./lib.ts";
import { b } from "./lib.ts";
console.log(a, b, c)
export const enum Level { Low }
`

function presetProject(create: (typeof LAYOUTS)[number]['create'], app: string) {
  return create({
    ...PRESET_CONFIGS,
    [`${app}tsconfig.json`]:
      app === ''
        ? { extends: 'uncheck/tsconfig/middleapi', include: ['src'] }
        : {
            extends: 'uncheck/tsconfig/middleapi/lib',
            references: [{ path: '../core' }],
            include: ['src'],
          },
    [`${app}src/legacy.ts`]: 'var count = 1\nif (count == 1) {\n  count = 2\n}\nexport { count }\n',
    [`${app}src/strict.ts`]: `export function first(items: string[]): string {
  return items[0]
}

export function identity(value) {
  return value
}
`,
    [`${app}src/bugs.ts`]: `export function parse() {
  try { JSON.parse("x") }
  catch (error) { throw new Error("parse failed") }
}
export function assign(a: number, b: number) { a -= a - b; return a }
export function collect(xs: number[]) { let out: number[] = []; for (const x of xs) { out = [...out, x] } return out }
export function confuse(a: string | null, b: string) { return a! == b }
export class Recurse { get v(): number { return this.v } }
export function fill() { return new Array(3).fill([]) }
export function negate(a: boolean, b: boolean) { return !a === b }
export class Construct { constructor() { return { x: 1 } } }
`,
    [`${app}src/lib.ts`]: 'export const a = 1\nexport const b = 2\n',
    [`${app}src/other.ts`]: 'export const c = 3\n',
    [`${app}src/use.ts`]: USE_BEFORE_FIX,
    [`${app}src/warn.ts`]: `import { a } from './lib.ts'
import { b } from './lib.ts'

export function pause() {
  debugger
  return a + b
}
`,
    [`${app}src/log.ts`]: "console.warn('careful')\nconsole.error('failed')\n",
  })
}

describe.each(LAYOUTS)('uncheck with the middleapi presets in a $name', ({ create, app, tsc }) => {
  const { sherif, checks } = layoutChecks(app)

  it('reports the problems the presets catch', async () => {
    const project = presetProject(create, app)

    const { exitCode, stdout } = await project.uncheck()

    for (const rule of [
      'eslint(no-var)',
      'eslint(eqeqeq)',
      'eslint(no-console)',
      'oxc(no-const-enum)',
      'import(no-duplicates)',
      ...BUG_RULES,
    ]) {
      expect(stdout).toContain(rule)
    }

    expect(stdout).toContain(`${app}src/index.ts`)
    expect(stdout).toContain('error TS2322')
    expect(stdout).toContain('error TS7006')
    expect(stdout).not.toContain('TS5097')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      FULL_OXLINT,
      '✘ oxlint failed',
      FULL_OXFMT,
      '✘ oxfmt failed',
      '○ knip skipped, not installed',
      tsc,
      '✘ tsc failed',
      `✘ 3 of ${checks.length} checks failed: oxlint, oxfmt, tsc`,
      '  rerun with `--fix` to apply oxlint and oxfmt fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('reports warnings without failing the run', async () => {
    const project = presetProject(create, app)

    const { exitCode, stdout } = await project.uncheck([
      '--only=oxlint',
      `${app}src/warn.ts`,
      `${app}src/log.ts`,
    ])

    expect(stdout).toContain('eslint(no-debugger)')
    expect(stdout).toContain('import(no-duplicates)')
    expect(stdout).not.toContain('no-console')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/log.ts ${app}src/warn.ts`,
      '✔ oxlint passed',
      '○ oxfmt skipped, not selected by --only',
      '○ knip skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint)',
    ])
    expect(exitCode).toBe(0)
  })

  it('fixes what the presets can fix', async () => {
    const project = presetProject(create, app)

    const { exitCode, stdout } = await project.uncheck(['--fix', '--skip=tsc'])

    expect(stdout).toContain('eslint(no-console)')
    expect(stdout).toContain('eslint(eqeqeq)')
    expect(stdout).not.toContain('import(no-duplicates)')
    expect(stdout).not.toContain('oxc(no-const-enum)')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...layoutChecks(app, { fix: true }).sherif,
      FULL_OXLINT_FIX,
      '✘ oxlint failed',
      FULL_OXFMT_FIX,
      '✔ oxfmt passed',
      '○ knip skipped, not installed',
      '○ tsc skipped, disabled with --skip=tsc',
      `✘ 1 of ${checks.length - 1} checks failed: oxlint`,
    ])
    expect(exitCode).toBe(1)
    expect(project.read(`${app}src/use.ts`)).toBe(
      "import { a, b } from './lib.ts'\nimport { c } from './other.ts'\nconsole.log(a, b, c)\nexport enum Level {\n  Low,\n}\n",
    )
    expect(project.read(`${app}src/index.ts`)).toMatch(
      /^import \{ double \} from '[^']+'\n\nexport const answer: number = double\(21\)\n$/,
    )
    expect(project.read(`${app}src/legacy.ts`)).toBe(
      'let count = 1\nif (count == 1) {\n  count = 2\n}\nexport { count }\n',
    )
  })
})
