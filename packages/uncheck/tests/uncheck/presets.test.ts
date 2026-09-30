import { createProject, eachLayout } from '../_shared/project'

/** The configs the presets' docs show, reaching them through the installed `uncheck` package. */
const CONFIGS = {
  '.oxlintrc.json': null,
  '.oxfmtrc.json': null,
  'oxlint.config.ts': [
    "import { defineConfig } from 'oxlint'",
    "import { middleapi } from 'uncheck/oxlint'",
    '',
    'export default defineConfig({',
    '  extends: [middleapi],',
    '})',
    '',
  ].join('\n'),
  'oxfmt.config.ts': [
    "import { defineConfig } from 'oxfmt'",
    "import { middleapi } from 'uncheck/oxfmt'",
    '',
    'export default defineConfig({',
    '  ...middleapi,',
    '})',
    '',
  ].join('\n'),
}

const BUGS = [
  'export function parse() {',
  '  try { JSON.parse("x") }',
  '  catch (error) { throw new Error("parse failed") }',
  '}',
  'export function assign(a: number, b: number) { a -= a - b; return a }',
  'export function collect(xs: number[]) { let out: number[] = []; for (const x of xs) { out = [...out, x] } return out }',
  'export function confuse(a: string | null, b: string) { return a! == b }',
  'export class Recurse { get v(): number { return this.v } }',
  'export function fill() { return new Array(3).fill([]) }',
  'export function negate(a: boolean, b: boolean) { return !a === b }',
  'export class Construct { constructor() { return { x: 1 } } }',
  '',
].join('\n')

eachLayout('uncheck presets in a $layout repository', ({ layout }) => {
  it('lints with the middleapi oxlint preset and formats with the middleapi oxfmt preset', async () => {
    const project = createProject(layout, { files: CONFIGS })

    project.write({
      [project.inApp('src/index.ts')]:
        'import { a } from "./lib";\nimport { b } from "./lib";\nconsole.log(a, b)\nexport const enum Level { Low }\n',
      [project.inApp('src/lib.ts')]: 'export const a = 1\nexport const b = 2\n',
      [project.inApp('src/warn.ts')]:
        "import { a } from './lib'\nimport { b } from './lib'\n\nexport function pause() {\n  debugger\n  return a + b\n}\n",
      [project.inApp('src/bugs.ts')]: BUGS,
    })

    const check = await project.run(['--skip=tsc'])

    expect(check.code).toBe(1)
    expect(check.stdout).toContain('✘ oxlint failed')
    expect(check.stdout).toContain('✘ oxfmt failed')

    for (const rule of [
      'eslint(no-console)',
      'import(no-duplicates)',
      'oxc(no-const-enum)',
      'eslint(preserve-caught-error)',
      'oxc(misrefactored-assign-op)',
      'oxc(no-accumulating-spread)',
      'typescript(no-confusing-non-null-assertion)',
      'unicorn(no-accessor-recursion)',
      'unicorn(no-array-fill-with-reference-type)',
      'unicorn(no-negation-in-equality-check)',
      'eslint(no-constructor-return)',
    ]) {
      expect(check.stdout).toContain(rule)
    }

    // `warn` rules, a default one and `import/no-duplicates`, report without failing the run; the
    // output format depends on the environment (a terminal, CI or an agent), so only names are matched.
    const warned = await project.run(['--only=oxlint', 'src/warn.ts'], { cwd: project.appDir })

    expect(warned.code).toBe(0)
    expect(warned.stdout).toContain('eslint(no-debugger)')
    expect(warned.stdout).toContain('import(no-duplicates)')

    // From the package too, which finds the configs at the top.
    const fix = await project.run(['--fix', '--skip=tsc'], { cwd: project.appDir })

    expect(fix.code).toBe(1)
    expect(fix.stdout).toContain('eslint(no-console)')
    expect(fix.stdout).not.toContain('import(no-duplicates)')
    expect(fix.stdout).not.toContain('oxc(no-const-enum)')
    expect(project.read(project.inApp('src/index.ts'))).toBe(
      "import { a, b } from './lib'\nconsole.log(a, b)\nexport enum Level {\n  Low,\n}\n",
    )
  })

  it('type checks with the middleapi tsconfig presets', async () => {
    const project = createProject(layout)

    project.write({
      [project.inApp('src/index.ts')]: [
        'export function identity(value) {',
        '  return value',
        '}',
        'export function first(items: string[]): string {',
        '  return items[0]',
        '}',
        '',
      ].join('\n'),
      [project.inApp('src/use.ts')]:
        "import { first } from './index.ts'\n\nexport const name: string = first(['a'])\n",
    })

    for (const preset of ['uncheck/tsconfig/middleapi', 'uncheck/tsconfig/middleapi/lib']) {
      project.write({ [project.inApp('tsconfig.json')]: { extends: preset, include: ['src'] } })

      const check = await project.run(['--only=tsc', 'src/index.ts'], { cwd: project.appDir })

      expect(check.code).toBe(1)
      expect(check.stdout).toContain('▶ tsc -p tsconfig.json --noEmit')
      // `strict` and `noUncheckedIndexedAccess` come from the base preset, through the lib one.
      expect(check.stdout).toContain('error TS7006')
      expect(check.stdout).toContain('error TS2322')
      // Node runs TypeScript only through imports that name the .ts file.
      expect(check.stdout).not.toContain('TS5097')
    }
  })
})
