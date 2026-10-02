import { LAYOUTS, monorepo, report, singleRepo } from '../utils/project'
import {
  CODE_WITH_TYPE_ERROR,
  CONFIG_DIR,
  NO_EMIT,
  NOT_COVERED,
  OUT_DIR,
  SKIPPED_BESIDE_TSC,
  tscPlan,
  withFakeTsc,
} from './utils'

describe.each(LAYOUTS)('tsc project references in a $name', ({ create, app }) => {
  it('builds a solution-style tsconfig.json whose references have other names', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      },
      [`${app}tsconfig.app.json`]: { ...NO_EMIT, include: ['src'] },
      [`${app}tsconfig.node.json`]: { ...NO_EMIT, include: ['vite.config.ts'] },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['vite.config.ts'])).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['scripts/release.ts'])).toEqual([NOT_COVERED])
  })

  it('builds a references graph whose projects keep their output away from their sources, also through extends', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: ['no-emit', 'declarations', 'out-dir', 'out-file'].map((dir) => ({
          path: `./${dir}`,
        })),
      },
      [`${app}tsconfig.base.json`]: NO_EMIT,
      [`${app}tsconfig.dist.json`]: { compilerOptions: { outDir: `${CONFIG_DIR}/dist` } },
      [`${app}no-emit/tsconfig.json`]: { extends: '../tsconfig.base.json', include: ['src'] },
      [`${app}declarations/tsconfig.json`]: {
        extends: '../tsconfig.base.json',
        compilerOptions: { noEmit: false, emitDeclarationOnly: true },
        include: ['src'],
      },
      [`${app}out-dir/tsconfig.json`]: { extends: '../tsconfig.dist.json', include: ['src'] },
      [`${app}out-file/tsconfig.json`]: {
        compilerOptions: { outFile: 'index.js' },
        include: ['src'],
      },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
  })

  it('checks with -p the projects whose tsc -b would write JavaScript next to sources, after building the projects they reference', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: [{ path: './web' }, { path: './node' }, { path: './shared' }],
      },
      [`${app}tsconfig.base.json`]: NO_EMIT,
      [`${app}web/tsconfig.json`]: {
        ...NO_EMIT,
        include: ['src'],
        references: [{ path: '../node' }, { path: '../ui' }, { path: '../legacy' }],
      },
      [`${app}node/tsconfig.json`]: {
        extends: '../tsconfig.base.json',
        compilerOptions: { composite: true, noEmit: false },
        include: ['vite.config.ts'],
      },
      [`${app}ui/tsconfig.json`]: {
        compilerOptions: { composite: true, outDir: 'dist' },
        include: ['src'],
        references: [{ path: '../shared' }],
      },
      [`${app}shared/tsconfig.json`]: { ...OUT_DIR, include: ['src'] },
      [`${app}docs/tsconfig.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../shared' }],
      },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b docs/tsconfig.json shared/tsconfig.json ui/tsconfig.json',
      '▶ tsc -p node/tsconfig.json --noEmit --composite false --declaration',
      '▶ tsc -p tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['node/vite.config.ts'])).toEqual([
      '▶ tsc -b ui/tsconfig.json',
      '▶ tsc -p node/tsconfig.json --noEmit --composite false --declaration',
      '▶ tsc -p tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['shared/src/index.ts'])).toEqual([
      '▶ tsc -b docs/tsconfig.json shared/tsconfig.json ui/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
      '▶ tsc -p web/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['tsconfig.json'])).toEqual([
      '▶ tsc -p tsconfig.json --noEmit',
    ])
  })

  it('builds with tsc -b the projects whose JavaScript next to their sources git ignores, also from the folder of one', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { files: [], references: [{ path: './lib' }, { path: './web' }] },
      [`${app}lib/.gitignore`]: '*.js\n',
      [`${app}lib/tsconfig.json`]: { compilerOptions: { composite: true }, include: ['src'] },
      [`${app}lib/src/index.ts`]: '',
      [`${app}web/.gitignore`]: '*.js\n',
      [`${app}web/tsconfig.json`]: {
        compilerOptions: { composite: true },
        include: ['src'],
        references: [{ path: '../lib' }],
      },
      [`${app}web/src/index.ts`]: '',
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, `${app}web`)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, `${app}web`, ['src/index.ts'])).toEqual([
      '▶ tsc -b tsconfig.json',
    ])
  })

  it('follows references to a folder, to a .json file and with backslashes', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: [{ path: 'web' }, { path: '.\\server\\tsconfig.build.json' }],
      },
      [`${app}web/tsconfig.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../ui/tsconfig.json' }],
      },
      [`${app}ui/tsconfig.json`]: { ...OUT_DIR, include: ['src'] },
      [`${app}server/tsconfig.build.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '..\\shared' }],
      },
      [`${app}shared/tsconfig.json`]: { ...OUT_DIR, include: ['src'] },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['server/src/main.ts'])).toEqual(['▶ tsc -b tsconfig.json'])
    expect(
      await tscPlan(project, app, ['shared/src/index.ts', 'ui/src/index.ts', 'web/src/index.ts']),
    ).toEqual(['▶ tsc -b tsconfig.json'])
  })

  it(`follows a reference path with ${CONFIG_DIR} as written, like tsc`, async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['src'] },
      [`${app}web/tsconfig.json`]: { ...OUT_DIR, references: [{ path: `${CONFIG_DIR}/../lib` }] },
      [`${app}web/lib/tsconfig.json`]: { ...OUT_DIR, include: ['src'] },
      [`${app}lib/tsconfig.json`]: { include: ['src'] },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b web/tsconfig.json',
      '▶ tsc -p lib/tsconfig.json --noEmit',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
  })

  it('ignores references that are not objects with a string path', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        files: [],
        references: ['./scripts', { path: 42 }, null, { prepend: true }, { path: './lib' }],
      },
      [`${app}lib/tsconfig.json`]: { ...OUT_DIR, include: ['src'], references: './scripts' },
      [`${app}scripts/tsconfig.json`]: { include: ['.'] },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b tsconfig.json',
      '▶ tsc -p scripts/tsconfig.json --noEmit',
    ])
  })

  it('builds the roots of the reference graph that depend on the given files', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['scripts'] },
      [`${app}shared/tsconfig.json`]: { ...OUT_DIR, include: ['src'] },
      [`${app}web/tsconfig.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../shared' }],
      },
      [`${app}server/tsconfig.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../shared' }],
      },
      [`${app}cli/tsconfig.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../server' }],
      },
      [`${app}e2e/tsconfig.json`]: {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../web' }, { path: '../server' }],
      },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -b cli/tsconfig.json e2e/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['shared/src/index.ts'])).toEqual([
      '▶ tsc -b cli/tsconfig.json e2e/tsconfig.json',
    ])
    expect(await tscPlan(project, app, ['web/src/index.ts'])).toEqual([
      '▶ tsc -b e2e/tsconfig.json',
    ])
    expect(await tscPlan(project, app, ['cli/src/index.ts', 'scripts/release.ts'])).toEqual([
      '▶ tsc -b cli/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
  })

  it('checks each standalone tsconfig.json with -p --noEmit', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['src'] },
      [`${app}scripts/tsconfig.json`]: { include: ['.'] },
      [`${app}test/tsconfig.json`]: { include: ['.'] },
    })

    expect(await tscPlan(project, app)).toEqual([
      '▶ tsc -p scripts/tsconfig.json --noEmit',
      '▶ tsc -p test/tsconfig.json --noEmit',
      '▶ tsc -p tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, app, ['test/index.test.ts', 'scripts/release.ts'])).toEqual([
      '▶ tsc -p scripts/tsconfig.json --noEmit',
      '▶ tsc -p test/tsconfig.json --noEmit',
    ])
  })

  it('fails on circular references, naming only the configs on the cycle', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { include: ['scripts'] },
      [`${app}api/tsconfig.json`]: { references: [{ path: '../lib' }] },
      [`${app}lib/tsconfig.json`]: { references: [{ path: '../utils' }] },
      [`${app}utils/tsconfig.json`]: { references: [{ path: '../lib' }] },
    })
    const cycle = '✘ tsc circular project references between lib/tsconfig.json, utils/tsconfig.json'

    expect(await tscPlan(project, app)).toEqual([cycle])
    expect(await tscPlan(project, app, ['scripts/release.ts'])).toEqual([cycle])
  })

  it('leaves a reference to a missing config to tsc -b', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: { ...NO_EMIT, include: ['src'], references: [{ path: './legacy' }] },
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
    expect(await tscPlan(project, app, ['legacy/index.ts'])).toEqual([NOT_COVERED])
  })

  it('leaves a reference to a folder named like a config file to tsc -b', async () => {
    const project = withFakeTsc(create, {
      [`${app}tsconfig.json`]: {
        ...NO_EMIT,
        include: ['src'],
        references: [{ path: './lib.json' }],
      },
      [`${app}lib.json/index.ts`]: '',
    })

    expect(await tscPlan(project, app)).toEqual(['▶ tsc -b tsconfig.json'])
  })
})

describe('tsc project references across the packages of a monorepo', () => {
  it('builds every package that references a changed package, and no other', async () => {
    const project = withFakeTsc(monorepo, {
      'tsconfig.json': { include: ['scripts'] },
      'packages/web/package.json': { name: '@repo/web', version: '1.0.0', private: true },
      'packages/web/tsconfig.json': {
        ...OUT_DIR,
        include: ['src'],
        references: [{ path: '../core' }],
      },
      'packages/cli/package.json': { name: '@repo/cli', version: '1.0.0', private: true },
      'packages/cli/tsconfig.json': { include: ['src'] },
    })

    expect(await tscPlan(project, '', ['packages/core/src/index.ts'])).toEqual([
      '▶ tsc -b packages/app/tsconfig.json packages/web/tsconfig.json',
    ])
    expect(await tscPlan(project, '', ['packages/app/src/index.ts'])).toEqual([
      '▶ tsc -b packages/app/tsconfig.json',
    ])
    expect(await tscPlan(project, '', ['packages/cli/src/index.ts', 'scripts/release.ts'])).toEqual(
      ['▶ tsc -p packages/cli/tsconfig.json --noEmit', '▶ tsc -p tsconfig.json --noEmit'],
    )
  })

  it('checks a package on its own from its folder', async () => {
    const project = withFakeTsc(monorepo)

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'], { cwd: 'packages/core' })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path('packages/core')}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
  })
})

describe('tsc project references with the real compiler in a single repo', () => {
  const IN_PLACE = {
    strict: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    types: [],
    composite: true,
  }
  const COMPOSITE = { ...IN_PLACE, emitDeclarationOnly: true, outDir: 'dist', rootDir: 'src' }

  it('builds the library a Vite 4 app imports before checking the app with -p, writing no JavaScript', async () => {
    const project = singleRepo({
      'tsconfig.node.json': {
        compilerOptions: {
          composite: true,
          skipLibCheck: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          types: [],
        },
        include: ['vite.config.ts'],
      },
      'vite.config.ts': 'export default { base: "/" };\n',
      'lib/tsconfig.json': { compilerOptions: COMPOSITE, include: ['src'] },
      'lib/src/index.ts': 'export const one = 1;\n',
      'src/index.ts':
        'import { one } from "../lib/src/index";\n\nexport const two: number = one + 1;\n',
    })
      .update('tsconfig.json', (config) => ({
        ...config,
        references: [{ path: './tsconfig.node.json' }, { path: './lib' }],
      }))
      .commit()
    const plan = [
      '▶ tsc -b lib/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
      '▶ tsc -p tsconfig.node.json --noEmit --composite false --declaration',
    ]

    const passed = await project.uncheck(['--only=tsc'])

    expect(passed.exitCode).toBe(0)
    expect(report(passed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      ...plan,
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(project.git('status', '--porcelain', '--ignored')).toBe(
      '!! lib/dist/\n!! lib/tsconfig.tsbuildinfo\n!! node_modules/\n',
    )

    project.write({
      'lib/src/index.ts': 'export const one = "1";\n',
      'vite.config.ts': CODE_WITH_TYPE_ERROR,
    })

    const failed = await project.uncheck(['--only=tsc'])

    expect(failed.exitCode).toBe(1)
    expect(report(failed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      ...plan,
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(failed.stdout).toContain(
      "src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
    expect(failed.stdout).toContain(
      "vite.config.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
    expect(project.exists('vite.config.js')).toBe(false)
  })

  it('builds with tsc -b the projects whose JavaScript next to their sources git ignores, so a break across them fails after a build', async () => {
    const project = singleRepo({
      '.gitignore': 'node_modules\n*.js\n*.d.ts\n*.tsbuildinfo\n',
      'tsconfig.json': { files: [], references: [{ path: './lib' }, { path: './app' }] },
      'lib/tsconfig.json': { compilerOptions: IN_PLACE, include: ['src'] },
      'lib/src/index.ts': 'export const one = 1;\n',
      'app/tsconfig.json': {
        compilerOptions: IN_PLACE,
        include: ['src'],
        references: [{ path: '../lib' }],
      },
      'app/src/index.ts':
        'import { one } from "../../lib/src/index";\n\nexport const two: number = one + 1;\n',
    })

    const passed = await project.uncheck(['--only=tsc'])

    expect(passed.exitCode).toBe(0)
    expect(report(passed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -b tsconfig.json',
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(project.exists('lib/src/index.d.ts')).toBe(true)
    expect(project.git('status', '--porcelain')).toBe('')

    project.write({ 'lib/src/index.ts': 'export const one = "1";\n' })

    const failed = await project.uncheck(['--only=tsc', 'lib/src/index.ts'])

    expect(failed.exitCode).toBe(1)
    expect(report(failed.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -b tsconfig.json',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(failed.stdout).toContain(
      "app/src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
  })

  it('checks with -p a solution that references a project writing JavaScript next to its sources, so a reference to a deleted config fails', async () => {
    const project = singleRepo({
      'tsconfig.json': {
        files: [],
        references: [{ path: './tsconfig.node.json' }, { path: './tsconfig.app.json' }],
      },
      'tsconfig.node.json': { compilerOptions: IN_PLACE, include: ['vite.config.ts'] },
      'tsconfig.app.json': {
        compilerOptions: { ...IN_PLACE, noEmit: true },
        include: ['src'],
      },
      'vite.config.ts': 'export default { base: "/" };\n',
    })

    project.git('rm', '--quiet', '--', 'tsconfig.app.json')

    const missing = `error TS6053: File '${project.path('tsconfig.app.json')}' not found.`
    const full = await project.uncheck(['--only=tsc'])

    expect(full.exitCode).toBe(1)
    expect(report(full.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p tsconfig.json --noEmit',
      '▶ tsc -p tsconfig.node.json --noEmit --composite false --declaration',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(full.stdout).toContain(missing)

    const staged = await project.uncheck(['staged', '--only=tsc'])

    expect(staged.exitCode).toBe(1)
    expect(report(staged.stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(staged.stdout).toContain(missing)
    expect(project.exists('vite.config.js')).toBe(false)
  })

  it('builds roots in folders starting with - or @, which tsc would read as an option or a file of arguments', async () => {
    const project = singleRepo({
      'core/tsconfig.json': { compilerOptions: COMPOSITE, include: ['src'] },
      'core/src/index.ts': 'export const one = 1;\n',
      ...Object.fromEntries(
        ['-pkg', '@app'].flatMap((folder) => [
          [
            `${folder}/tsconfig.json`,
            { compilerOptions: COMPOSITE, include: ['src'], references: [{ path: '../core' }] },
          ],
          [`${folder}/src/index.ts`, CODE_WITH_TYPE_ERROR],
        ]),
      ),
    })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -b ./-pkg/tsconfig.json ./@app/tsconfig.json',
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])

    for (const folder of ['-pkg', '@app']) {
      expect(stdout).toContain(
        `\n${folder}/src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`,
      )
    }
  })

  it('runs the other checks when a reference names a file, and tsc reports it', async () => {
    const project = singleRepo({ 'README.md': '# App\n' }).update('tsconfig.json', (config) => ({
      ...config,
      references: [{ path: './README.md' }],
    }))

    const { exitCode, stdout } = await project.uncheck()

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not a workspace root',
      '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern',
      '✔ oxfmt passed',
      '▶ tsc -b tsconfig.json',
      '✘ tsc failed',
      '✘ 1 of 3 checks failed: tsc',
    ])
    expect(stdout).toContain(
      `error TS6053: File '${project.path('README.md/tsconfig.json')}' not found.`,
    )
  })
})
