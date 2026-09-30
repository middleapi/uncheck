import process from 'node:process'

import { eachLayout } from '../_shared/project'
import { CONFIG_DIR, NOT_COVERED, coverage, plan, runPlan, tscProject } from './tsc-plan'

eachLayout('$layout', ({ layout }) => {
  it('matches files like tsc: include folders, wildcards, extensions and default excludes', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {
        include: ['src', 'scripts/*.ts', 'config/*.json', '*/*/*'],
        exclude: ['src/legacy'],
      },
    })

    expect(
      await coverage(project, [
        'src/index.ts',
        'src/deep/nested/component.tsx',
        'src/types.d.ts',
        'src/index.js',
        'src/.hidden/index.ts',
        'src/node_modules/dep/index.ts',
        'src/legacy/old.ts',
        'scripts/build.ts',
        'scripts/nested/deep/build.ts',
        'config/app.json',
        'src/data.json',
        'modules/app/build.config.ts',
        'modules/app/src/index.ts',
        'node_modules/dep/index.ts',
      ]),
    ).toEqual({
      'src/index.ts': true,
      'src/deep/nested/component.tsx': true,
      'src/types.d.ts': true,
      'src/index.js': false,
      'src/.hidden/index.ts': false,
      'src/node_modules/dep/index.ts': false,
      'src/legacy/old.ts': false,
      'scripts/build.ts': true,
      'scripts/nested/deep/build.ts': false,
      'config/app.json': true,
      'src/data.json': false,
      'modules/app/build.config.ts': true,
      'modules/app/src/index.ts': false,
      'node_modules/dep/index.ts': false,
    })
  })

  it('skips tsc without looking at any config when no given file is one tsc could check', async () => {
    const project = tscProject(layout, { 'tsconfig.json': {} })

    const docs = await runPlan(project, ['README.md', 'styles.css'])

    expect(docs.tsc).toBe(NOT_COVERED)
    expect(docs.result.stdout).toContain(`○ tsc skipped, ${NOT_COVERED}\n`)
    // tsc is the only check selected, so nothing ran at all.
    expect(docs.result.code).toBe(1)
    expect(docs.result.stdout).toContain(`✘ nothing to check: `)
  })

  it('falls back to everything, minus node_modules, dot folders and outDir, when nothing is configured', async () => {
    const project = tscProject(layout, { 'tsconfig.json': { compilerOptions: { outDir: 'dist' } } })

    expect(
      await coverage(project, [
        'index.ts',
        'deep/index.ts',
        'dist/index.d.ts',
        'node_modules/dep/index.d.ts',
        '.cache/hooks/pre-commit.ts',
      ]),
    ).toEqual({
      'index.ts': true,
      'deep/index.ts': true,
      'dist/index.d.ts': false,
      'node_modules/dep/index.d.ts': false,
      '.cache/hooks/pre-commit.ts': false,
    })
  })

  it('takes the inputs tsc takes: no declarationDir, minified scripts or upper-case extensions, but an included node_modules folder', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {
        compilerOptions: { allowJs: true, declarationDir: 'src/types' },
        include: ['src', 'vendor/*', 'plugins/jquery*', 'node_modules/x'],
      },
    })

    expect(
      await coverage(project, [
        'src/index.ts',
        'src/types/index.d.ts',
        'vendor/jquery.js',
        'vendor/jquery.min.js',
        'vendor/jquery.min.jsx',
        'plugins/jquery.ui.js',
        'plugins/jquery.min.js',
        'src/UPPER.TS',
        'node_modules/x/index.ts',
        'node_modules/y/index.ts',
      ]),
    ).toEqual({
      'src/index.ts': true,
      'src/types/index.d.ts': false,
      'vendor/jquery.js': true,
      'vendor/jquery.min.js': false,
      'vendor/jquery.min.jsx': true,
      'plugins/jquery.ui.js': true,
      'plugins/jquery.min.js': false,
      'src/UPPER.TS': false,
      'node_modules/x/index.ts': true,
      'node_modules/y/index.ts': false,
    })
  })

  it('reads the less common patterns like tsc: literal files, ?, trailing slashes, a trailing ** and special characters', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {
        compilerOptions: { outDir: 42, declarationDir: null },
        include: [
          'entry.ts',
          'src/',
          'lib/?ndex.ts',
          'deep/**',
          'odd/a+(b).ts',
          'test/**/*.spec.ts',
        ],
        exclude: ['src/**/*.gen.ts', 'src/v?.ts'],
      },
    })

    expect(
      await coverage(project, [
        'entry.ts',
        'other.ts',
        'src/index.ts',
        'src/nested/index.ts',
        'src/nested/index.gen.ts',
        'src/v1.ts',
        'src/v10.ts',
        'lib/index.ts',
        'lib/xndex.ts',
        'lib/.ndex.ts',
        'deep/index.ts',
        'odd/a+(b).ts',
        'odd/aa(b).ts',
        'test/unit/math.spec.ts',
        'test/math.spec.ts',
        'test/math.ts',
      ]),
    ).toEqual({
      'entry.ts': true,
      'other.ts': false,
      'src/index.ts': true,
      'src/nested/index.ts': true,
      'src/nested/index.gen.ts': false,
      'src/v1.ts': false,
      'src/v10.ts': true,
      'lib/index.ts': true,
      'lib/xndex.ts': true,
      'lib/.ndex.ts': false,
      // tsc takes nothing from an include that ends in `**`.
      'deep/index.ts': false,
      'odd/a+(b).ts': true,
      'odd/aa(b).ts': false,
      'test/unit/math.spec.ts': true,
      'test/math.spec.ts': true,
      'test/math.ts': false,
    })
  })

  it('takes `files` as they are, and nothing else when there is no include', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {
        files: ['main.ts', 'data.json', 'legacy.js'],
        exclude: ['main.ts'],
        compilerOptions: 'not an object',
      },
    })

    expect(
      await coverage(project, ['main.ts', 'data.json', 'legacy.js', 'other.ts', 'src/index.ts']),
    ).toEqual({
      'main.ts': true,
      'data.json': true,
      'legacy.js': true,
      'other.ts': false,
      'src/index.ts': false,
    })
  })

  it('checks JavaScript with checkJs, and not when allowJs is turned off after it', async () => {
    const project = tscProject(layout, {
      'check/tsconfig.json': { compilerOptions: { checkJs: true, allowJs: false } },
      'off/tsconfig.base.json': { compilerOptions: { allowJs: true } },
      'off/tsconfig.json': { extends: './tsconfig.base.json', compilerOptions: { allowJs: false } },
    })

    expect(await coverage(project, ['check/index.js', 'off/index.js', 'off/index.mjs'])).toEqual({
      'check/index.js': true,
      'off/index.js': false,
      'off/index.mjs': false,
    })
  })

  it('selects only the projects whose inputs contain a given file', async () => {
    const lib = { extends: '../../tsconfig.base.json', include: ['src'], exclude: ['**/*.test.*'] }
    const project = tscProject(layout, {
      'tsconfig.base.json': { compilerOptions: { strict: true } },
      'tsconfig.json': { include: ['scripts', '*', '*/*/src/**/*.test.*', '*/*/*'] },
      'modules/a/tsconfig.json': lib,
      'modules/b/tsconfig.json': lib,
    })
    const a = '-p modules/a/tsconfig.json --noEmit'
    const b = '-p modules/b/tsconfig.json --noEmit'
    const root = '-p tsconfig.json --noEmit'

    const plans = await Promise.all([
      plan(project, ['modules/a/src/index.ts']),
      // Tests are excluded by the package and picked up by the root instead.
      plan(project, ['modules/a/src/index.test.ts']),
      plan(project, ['modules/a/build.config.ts']),
      plan(project, ['scripts/release.ts']),
      plan(project, ['modules/a/src/index.ts', 'modules/b/src/index.ts']),
      plan(project, ['README.md', 'modules/a/styles.css', 'modules/a/src/index.ts']),
      plan(project, ['README.md', 'modules/a/styles.css']),
      // A folder stands for the files in it.
      plan(project, ['modules/b/src']),
    ])

    expect(plans).toEqual([[a], [root], [root], [root], [a, b], [a], NOT_COVERED, [b]])
  })

  it('takes JSON files only through an include that names the extension, and changed configs through the projects they apply to', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': { include: ['src', 'data/*.json'] },
      'data/app.json': '{}\n',
    })

    expect(
      await coverage(project, ['data/app.json', 'src/data.json', 'data/other.ts', 'tsconfig.json']),
    ).toEqual({
      'data/app.json': true,
      'src/data.json': false,
      'data/other.ts': false,
      'tsconfig.json': true,
    })
  })

  it('substitutes configDir in include and exclude of the config itself', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': {
        include: [`${CONFIG_DIR}/src`],
        exclude: [`${CONFIG_DIR}/src/generated`],
      },
    })

    expect(await coverage(project, ['src/index.ts', 'src/generated/api.ts'])).toEqual({
      'src/index.ts': true,
      'src/generated/api.ts': false,
    })
  })

  it('matches include patterns with the case sensitivity of the platform, like tsc', async () => {
    const project = tscProject(layout, {
      'tsconfig.json': { include: ['SRC'], exclude: ['SRC/Legacy'] },
    })
    // tsc compares paths case-insensitively where the file system usually is: macOS and Windows.
    const insensitive = process.platform === 'darwin' || process.platform === 'win32'

    expect(await coverage(project, ['src/index.ts', 'SRC/index.ts', 'SRC/legacy/old.ts'])).toEqual({
      'src/index.ts': insensitive,
      'SRC/index.ts': true,
      'SRC/legacy/old.ts': !insensitive,
    })
  })
})
