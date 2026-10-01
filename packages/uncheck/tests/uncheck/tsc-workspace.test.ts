import type { Files, ProjectOptions } from '../utils/project'
import { monorepo, report } from '../utils/project'
import { SKIPPED_BESIDE_TSC, tscPlan, withFakeTsc } from './utils'

const PACKAGE_CONFIG = {
  compilerOptions: {
    strict: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    types: [],
    noEmit: true,
  },
  include: ['src'],
}

/** A workspace whose `app` imports the sources of `core` through its link alone, without project references. */
function linkedMonorepo(files: Files = {}, options?: ProjectOptions) {
  return monorepo(
    {
      'tsconfig.json': null,
      'packages/core/package.json': {
        name: '@repo/core',
        version: '1.0.0',
        private: true,
        type: 'module',
        exports: './src/index.ts',
      },
      'packages/core/tsconfig.json': PACKAGE_CONFIG,
      'packages/app/tsconfig.json': PACKAGE_CONFIG,
      ...files,
    },
    options,
  )
}

describe('tsc across the packages of a workspace', () => {
  it('checks the packages that depend on a changed one, directly or through others', async () => {
    const project = withFakeTsc(linkedMonorepo, {
      'packages/e2e/package.json': {
        name: '@repo/e2e',
        version: '1.0.0',
        private: true,
        devDependencies: { '@repo/app': 'workspace:*' },
      },
      'packages/e2e/tsconfig.json': PACKAGE_CONFIG,
      'packages/web/package.json': {
        name: '@repo/web',
        version: '1.0.0',
        private: true,
        peerDependencies: { react: '*' },
      },
      'packages/web/tsconfig.json': PACKAGE_CONFIG,
      'packages/ui/package.json': {
        name: '@repo/ui',
        version: '1.0.0',
        private: true,
        peerDependencies: { '@repo/core': 'workspace:*' },
      },
      'packages/ui/tsconfig.json': PACKAGE_CONFIG,
      'packages/cli/package.json': {
        name: '@repo/cli',
        version: '1.0.0',
        private: true,
        optionalDependencies: { '@repo/core': 'workspace:*' },
      },
      'packages/cli/tsconfig.json': PACKAGE_CONFIG,
      'packages/broken/package.json': 'oops\n',
    })

    expect(await tscPlan(project, '', ['packages/core/src/index.ts'])).toEqual([
      '▶ tsc -p packages/app/tsconfig.json --noEmit',
      '▶ tsc -p packages/cli/tsconfig.json --noEmit',
      '▶ tsc -p packages/core/tsconfig.json --noEmit',
      '▶ tsc -p packages/e2e/tsconfig.json --noEmit',
      '▶ tsc -p packages/ui/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, '', ['packages/app/src/index.ts'])).toEqual([
      '▶ tsc -p packages/app/tsconfig.json --noEmit',
      '▶ tsc -p packages/e2e/tsconfig.json --noEmit',
    ])
    expect(await tscPlan(project, '', ['packages/web/src/index.ts'])).toEqual([
      '▶ tsc -p packages/web/tsconfig.json --noEmit',
    ])
  })

  it('builds the configs that reference the config of a package depending on a changed one', async () => {
    const project = withFakeTsc(linkedMonorepo, {
      'tsconfig.json': { files: [], references: [{ path: 'packages/app' }] },
    })

    expect(await tscPlan(project, '', ['packages/core/src/index.ts'])).toEqual([
      '▶ tsc -b tsconfig.json',
      '▶ tsc -p packages/core/tsconfig.json --noEmit',
    ])
  })

  it('fails a change that breaks a package importing it through its workspace link', async () => {
    const project = linkedMonorepo().write({
      'packages/core/src/index.ts':
        'export function double(value: number): string {\n  return String(value);\n}\n',
    })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc', 'packages/core/src/index.ts'])

    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      '▶ tsc -p packages/app/tsconfig.json --noEmit',
      '▶ tsc -p packages/core/tsconfig.json --noEmit',
      '✘ tsc failed',
      '✘ 1 of 1 checks failed: tsc',
    ])
    expect(stdout).toContain(
      "packages/app/src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
  })
})
