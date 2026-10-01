import {
  cliError,
  LAYOUTS,
  monorepo,
  project as bareProject,
  report,
  singleRepo,
} from '../utils/project'
import { folderOf, inIndex } from './utils'

describe.each(LAYOUTS)('uncheck staged in a $name', ({ create, app, tsc }) => {
  const folder = folderOf(app)

  it('needs a git repository', async () => {
    const project = create({}, { git: 'none' })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'], { cwd: folder })

    expect(stderr).toBe(cliError('`uncheck staged` needs a git repository'))
    expect(stdout).toBe('')
    expect(exitCode).toBe(1)
  })

  it('shows why git refuses the repository', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'], {
      cwd: folder,
      env: { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
    })

    expect(project.normalize(stderr)).toContain(
      cliError("fatal: detected dubious ownership in repository at '<project>'").trimEnd(),
    )
    expect(stderr).toContain('safe.directory')
    expect(stdout).toBe('')
    expect(exitCode).toBe(1)
  })

  it('has nothing to check when nothing is staged', async () => {
    const project = create()

    project.write({ [`${app}src/index.ts`]: 'var   unstaged = 1\n' })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'], { cwd: folder })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ nothing to check, no staged files',
    ])
  })

  it('passes clean staged files and leaves unstaged and untracked ones out', async () => {
    const project = create()

    project.stage({ [`${app}src/extra.ts`]: 'export const extra: number = 1;\n' })
    project.write({
      [`${app}src/index.ts`]: `${project.read(`${app}src/index.ts`)}var   unstaged = 1\n`,
      [`${app}src/untracked.ts`]: 'var   untracked = 1\n',
    })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'], { cwd: folder })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
    expect(project.git('status', '--porcelain')).toBe(
      `A  ${app}src/extra.ts\n M ${app}src/index.ts\n?? ${app}src/untracked.ts\n`,
    )
  })

  it('fails on lint, format and type errors in the staged files without touching them', async () => {
    const broken = 'var   answer: number = "42"\nexport { answer }\n'
    const project = create().stage({ [`${app}src/index.ts`]: broken })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'], { cwd: folder })

    expect(stderr).toBe('')
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --no-error-on-unmatched-pattern src/index.ts',
      '✘ oxlint failed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern src/index.ts',
      '✘ oxfmt failed',
      tsc,
      '✘ tsc failed',
      '✘ 3 of 3 checks failed: oxlint, oxfmt, tsc',
      '  rerun with `--fix` to apply oxlint and oxfmt fixes',
    ])
    expect(stdout).toContain("error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(inIndex(project, `${app}src/index.ts`)).toBe(broken)
    expect(project.read(`${app}src/index.ts`)).toBe(broken)
  })

  it('passes --skip, --only and --require through to the checks', async () => {
    const project = create({ [`${app}README.md`]: '# app\n' }).stage({
      [`${app}README.md`]: '# app\n\nmore\n',
      [`${app}src/extra.ts`]: 'export const   extra = 1\n',
    })

    const skipped = await project.uncheck(['staged', '--skip=oxlint', '--skip=tsc'], {
      cwd: folder,
    })

    expect(skipped.exitCode).toBe(1)
    expect(report(skipped.stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, no package.json among the given files',
      '○ oxlint skipped, disabled with --skip=oxlint',
      '▶ oxfmt --check --no-error-on-unmatched-pattern README.md src/extra.ts',
      '✘ oxfmt failed',
      '○ tsc skipped, disabled with --skip=tsc',
      '✘ 1 of 1 checks failed: oxfmt',
      '  rerun with `--fix` to apply oxfmt fixes',
    ])

    project.git('reset', '--quiet', '--', `${app}src/extra.ts`)

    const unneeded = await project.uncheck(['staged', '--only=tsc'], { cwd: folder })

    expect(unneeded.exitCode).toBe(0)
    expect(report(unneeded.stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, not selected by --only',
      '○ tsc skipped, no tsconfig.json covers the given files',
      '○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files',
    ])

    const required = await project.uncheck(['staged', '--only=tsc', '--require=tsc'], {
      cwd: folder,
    })

    expect(required.exitCode).toBe(1)
    expect(report(required.stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, not selected by --only',
      '✘ tsc no tsconfig.json covers the given files',
      '✘ 1 of 1 checks failed: tsc',
    ])
  })

  it('lists more than three files as a count', async () => {
    const project = create().stage({
      [`${app}src/a.ts`]: 'export const   a = 1\n',
      [`${app}src/b.ts`]: 'export const   b = 1\n',
      [`${app}src/c.ts`]: 'export const   c = 1\n',
      [`${app}src/d.ts`]: 'export const   d = 1\n',
    })

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '▶ oxfmt --no-error-on-unmatched-pattern [4 files]',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxfmt)',
      '✔ staged the fixes to [4 files]',
    ])
    expect(inIndex(project, `${app}src/d.ts`)).toBe('export const d = 1;\n')
  })
})

describe('uncheck staged without tools', () => {
  it('fails when no check can run on the staged files', async () => {
    const project = bareProject(
      { 'package.json': { name: 'bare', private: true } },
      { tools: [] },
    ).stage({ 'src/index.ts': 'export const answer = 42;\n' })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'])

    expect(stderr).toBe('')
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      '○ sherif skipped, not installed',
      '○ oxlint skipped, not installed',
      '○ oxfmt skipped, not installed',
      '○ tsc skipped, no tsconfig.json found',
      '✘ nothing to check: sherif not installed, oxlint not installed, oxfmt not installed, tsc no tsconfig.json found',
    ])
  })
})

describe('uncheck staged flags', () => {
  it('rejects a selection that contradicts itself before looking at git', async () => {
    const project = singleRepo({}, { git: 'none' })

    const { exitCode, stdout, stderr } = await project.uncheck([
      'staged',
      '--only=oxlint',
      '--skip=oxlint',
    ])

    expect(stderr).toBe(cliError('--only=oxlint and --skip=oxlint contradict each other.'))
    expect(stdout).toBe('')
    expect(exitCode).toBe(1)
  })
})

describe('uncheck staged in a package of a monorepo', () => {
  const edits = {
    'packages/app/src/index.ts': 'export const   app = 1\n',
    'packages/core/src/index.ts': 'export const   core = 1\n',
  }

  it('checks and fixes only the staged files of the package it runs in', async () => {
    const project = monorepo().stage(edits)

    const inside = await project.uncheck(['staged', '--only=oxfmt'], { cwd: 'packages/app' })
    const fromTop = await project.uncheck(['staged', '--only=oxfmt', '--cwd', 'packages/app'])

    for (const { exitCode, stdout } of [inside, fromTop]) {
      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual([
        `uncheck staged in ${project.path('packages/app')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '▶ oxfmt --check --no-error-on-unmatched-pattern src/index.ts',
        '✘ oxfmt failed',
        '○ tsc skipped, not selected by --only',
        '✘ 1 of 1 checks failed: oxfmt',
        '  rerun with `--fix` to apply oxfmt fixes',
      ])
    }

    const fixed = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: 'packages/app',
    })

    expect(fixed.exitCode).toBe(0)
    expect(report(fixed.stdout).at(-1)).toBe('✔ staged the fixes to src/index.ts')
    expect(inIndex(project, 'packages/app/src/index.ts')).toBe('export const app = 1;\n')
    expect(inIndex(project, 'packages/core/src/index.ts')).toBe(edits['packages/core/src/index.ts'])
  })

  it('reports what sherif finds in the workspace but leaves its fixes to `uncheck --fix`', async () => {
    const manifest = {
      name: '@repo/app',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: { '@repo/core': 'workspace:*' },
      devDependencies: { typescript: '^6.0.0' },
    }
    const project = monorepo().stage({
      'packages/app/package.json': manifest,
      'packages/app/src/index.ts': 'var   app = 1\nexport { app }\n',
    })

    const checked = await project.uncheck(['staged', '--skip=tsc'])

    expect(checked.exitCode).toBe(1)
    expect(report(checked.stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      '▶ oxlint --no-error-on-unmatched-pattern packages/app/package.json packages/app/src/index.ts',
      '✘ oxlint failed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern packages/app/package.json packages/app/src/index.ts',
      '✘ oxfmt failed',
      '○ tsc skipped, disabled with --skip=tsc',
      '✘ 3 of 3 checks failed: sherif, oxlint, oxfmt',
      '  rerun with `--fix` to apply oxlint and oxfmt fixes',
    ])

    const fixed = await project.uncheck(['staged', '--fix', '--skip=tsc'])

    expect(fixed.exitCode).toBe(1)
    expect(report(fixed.stdout)).toEqual([
      `uncheck staged in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      '▶ oxlint --fix --no-error-on-unmatched-pattern packages/app/package.json packages/app/src/index.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern packages/app/package.json packages/app/src/index.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, disabled with --skip=tsc',
      '✘ 1 of 3 checks failed: sherif',
      '✔ staged the fixes to packages/app/src/index.ts',
    ])
    expect(JSON.parse(inIndex(project, 'packages/app/package.json'))).toEqual(manifest)
    expect(JSON.parse(project.read('packages/app/package.json'))).toEqual(manifest)
  })
})
