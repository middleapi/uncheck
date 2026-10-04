import type { Files, Project } from '../utils/project'
import { commitWithHooks, LAYOUTS, monorepo, report, SKIPPED_FOR_DELETIONS } from '../utils/project'
import { HUSKY_4_BANNER, HUSKY_4_RUNNER, installHusky, prepare } from './utils'

const LINT_CONFIG = { rules: { 'no-var': 'error', 'no-empty-pattern': 'error' } }

const UNFIXABLE = 'export function ignore({}: object): void {}\n'

const TSC_WITHOUT_REFERENCES = '▶ tsc -p tsconfig.json --noEmit'

const TSC_WITH_REFERENCES = '▶ tsc -b tsconfig.json'

async function preparedMonorepo(files?: Files): Promise<Project> {
  const project = monorepo(files)
  await prepare(project, [], { cwd: 'packages/core' })
  await prepare(project, [], { cwd: 'packages/app' })

  return project
}

function blockedByLint(dir: string, tsc: string, file = 'src/ignore.ts'): string[] {
  return [
    `uncheck staged in ${dir}`,
    '○ sherif skipped, no package.json among the given files',
    `▶ oxlint --fix --no-error-on-unmatched-pattern ${file}`,
    '✘ oxlint failed',
    `▶ oxfmt --no-error-on-unmatched-pattern ${file}`,
    '✔ oxfmt passed',
    '○ knip skipped, not installed',
    tsc,
    '✔ tsc passed',
    '✘ 1 of 3 checks failed: oxlint',
  ]
}

function fixedAndStaged(dir: string, tsc: string): string[] {
  return [
    `uncheck staged in ${dir}`,
    '○ sherif skipped, no package.json among the given files',
    '▶ oxlint --fix --no-error-on-unmatched-pattern src/spaced.ts',
    '✔ oxlint passed',
    '▶ oxfmt --no-error-on-unmatched-pattern src/spaced.ts',
    '✔ oxfmt passed',
    '○ knip skipped, not installed',
    tsc,
    '✔ tsc passed',
    '✔ staged the fixes to src/spaced.ts',
    '✔ all checks passed (oxlint, oxfmt, tsc)',
  ]
}

describe.each(LAYOUTS)('committing with the prepared hook in a $name', ({ create, app, tsc }) => {
  it('blocks a commit with a lint error it cannot fix', async () => {
    const project = create({ '.oxlintrc.json': LINT_CONFIG })
    await prepare(project, [], { cwd: app })
    project.stage({ [`${app}src/ignore.ts`]: UNFIXABLE })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=ignore')

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual(blockedByLint(project.path(app, '.'), tsc))
    expect(project.git('log', '--format=%s')).toBe('init\n')
    expect(project.git('diff', '--cached', '--name-only')).toBe(`${app}src/ignore.ts\n`)
  })

  it('commits the fixes it applied', async () => {
    const project = create()
    await prepare(project, [], { cwd: app })
    project.stage({ [`${app}src/spaced.ts`]: 'export var spaced   =   1\n' })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=spaced')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual(fixedAndStaged(project.path(app, '.'), tsc))
    expect(project.git('log', '--format=%s')).toBe('spaced\ninit\n')
    expect(project.git('show', `HEAD:${app}src/spaced.ts`)).toBe('export const spaced = 1;\n')
    expect(project.read(`${app}src/spaced.ts`)).toBe('export const spaced = 1;\n')
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('blocks a commit before the runner of husky 4, which always exits', async () => {
    const project = create({ '.oxlintrc.json': LINT_CONFIG })
    project.write({
      '.git/hooks/pre-commit': `${HUSKY_4_BANNER}${HUSKY_4_RUNNER}\n`,
      '.git/hooks/husky.sh': 'echo "husky 4 ran" >&2\nexit 0\n',
    })
    await prepare(project, [], { cwd: app })
    project.stage({ [`${app}src/ignore.ts`]: UNFIXABLE })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=ignore')

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual(blockedByLint(project.path(app, '.'), tsc))
    expect(stderr).not.toContain('husky 4 ran')
    expect(project.git('log', '--format=%s')).toBe('init\n')
  })

  it('runs through the husky 9 dispatcher before the commands of the hook', async () => {
    const project = installHusky(create(), 'echo "husky hook ran"\n')
    await prepare(project, [], { cwd: app })
    project.commit('husky')
    project.stage({ [`${app}src/spaced.ts`]: 'export const spaced   =   1\n' })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=spaced')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual(fixedAndStaged(project.path(app, '.'), tsc))
    expect(stderr).toMatch(/\nhusky hook ran\n$/)
    expect(project.git('show', `HEAD:${app}src/spaced.ts`)).toBe('export const spaced = 1;\n')
  })
})

describe('committing with the prepared hook of several packages in a monorepo', () => {
  it('stops at the first package whose line fails', async () => {
    const project = await preparedMonorepo({ '.oxlintrc.json': LINT_CONFIG })
    project.stage({
      'packages/core/src/ignore.ts': UNFIXABLE,
      'packages/app/src/spaced.ts': 'export const spaced   =   1\n',
    })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=both')

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual(
      blockedByLint(project.path('packages/core'), TSC_WITHOUT_REFERENCES),
    )
    expect(project.read('packages/app/src/spaced.ts')).toBe('export const spaced   =   1\n')
    expect(project.git('log', '--format=%s')).toBe('init\n')
  })

  it('skips the line of a package the commit leaves alone', async () => {
    const project = await preparedMonorepo()
    project.stage({ 'packages/app/src/spaced.ts': 'export var spaced   =   1\n' })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=spaced')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual(
      fixedAndStaged(project.path('packages/app'), TSC_WITH_REFERENCES),
    )
    expect(project.git('log', '--format=%s')).toBe('spaced\ninit\n')
  })

  it('checks the files of `git commit <paths>` in a package', async () => {
    const project = await preparedMonorepo({ '.oxlintrc.json': LINT_CONFIG })
    project.write({ 'packages/app/src/index.ts': UNFIXABLE })

    const { exitCode, stderr } = await commitWithHooks(
      project,
      '--message=ignore',
      '--',
      'packages/app/src/index.ts',
    )

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual(
      blockedByLint(project.path('packages/app'), TSC_WITH_REFERENCES, 'src/index.ts'),
    )
    expect(project.git('log', '--format=%s')).toBe('init\n')
  })

  it('runs the line of a package the commit only deletes from', async () => {
    const project = await preparedMonorepo()
    project.git('rm', '--quiet', 'packages/app/src/index.ts')

    const { exitCode, stderr } = await commitWithHooks(project, '--message=remove')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual([
      `uncheck staged in ${project.path('packages/app')}`,
      ...SKIPPED_FOR_DELETIONS,
      TSC_WITH_REFERENCES,
      '✔ tsc passed',
      '✔ all checks passed (tsc)',
    ])
    expect(project.git('log', '--format=%s')).toBe('remove\ninit\n')
  })

  it('skips the line of a package that was moved away', async () => {
    const project = await preparedMonorepo()
    project.git('mv', 'packages/app', 'packages/web')
    await prepare(project, [], { cwd: 'packages/web' })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=rename')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual([
      `uncheck staged in ${project.path('packages/web')}`,
      '○ sherif skipped, not a workspace root',
      '▶ oxlint --fix --no-error-on-unmatched-pattern package.json src/index.ts tsconfig.json',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern package.json src/index.ts tsconfig.json',
      '✔ oxfmt passed',
      '○ knip skipped, not installed',
      TSC_WITH_REFERENCES,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
    expect(project.git('log', '--format=%s')).toBe('rename\ninit\n')
  })

  it('skips the line of a package a sparse checkout leaves out', async () => {
    const project = await preparedMonorepo()
    project.git('sparse-checkout', 'set', 'packages/core')
    project.stage({ 'packages/core/src/spaced.ts': 'export var spaced   =   1\n' })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=spaced')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual(
      fixedAndStaged(project.path('packages/core'), TSC_WITHOUT_REFERENCES),
    )
    expect(project.git('log', '--format=%s')).toBe('spaced\ninit\n')
  })

  it('checks a package whose folder name git could read as pathspec magic', async () => {
    const project = monorepo({ '.oxlintrc.json': LINT_CONFIG })
    project.stage({ ':docs/src/ignore.ts': UNFIXABLE })
    await prepare(project, [], { cwd: ':docs' })

    const { exitCode, stderr } = await commitWithHooks(project, '--message=ignore')

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual([
      `uncheck staged in ${project.path(':docs')}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/ignore.ts',
      '✘ oxlint failed',
      '▶ oxfmt --no-error-on-unmatched-pattern src/ignore.ts',
      '✔ oxfmt passed',
      '○ knip skipped, not installed',
      '○ tsc skipped, no tsconfig.json covers the given files',
      '✘ 1 of 2 checks failed: oxlint',
    ])
    expect(project.git('log', '--format=%s')).toBe('init\n')
  })
})
