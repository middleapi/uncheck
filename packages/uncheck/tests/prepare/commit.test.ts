import type { Project } from '../utils/project'
import { LAYOUTS, monorepo, report, run } from '../utils/project'
import { installHusky, prepare } from './utils'

const LINT_CONFIG = { rules: { 'no-var': 'error', 'no-empty-pattern': 'error' } }

const UNFIXABLE = 'export function ignore({}: object): void {}\n'

const TSC_WITHOUT_REFERENCES = '▶ tsc -p tsconfig.json --noEmit'

function commit(project: Project, message: string) {
  return run(['git', 'commit', '--quiet', `--message=${message}`], { cwd: project.dir })
}

function blockedByLint(dir: string, tsc: string): string[] {
  return [
    `uncheck staged in ${dir}`,
    '○ sherif skipped, no package.json among the given files',
    '▶ oxlint --fix --no-error-on-unmatched-pattern src/ignore.ts',
    '✘ oxlint failed',
    '▶ oxfmt --no-error-on-unmatched-pattern src/ignore.ts',
    '✔ oxfmt passed',
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
    tsc,
    '✔ tsc passed',
    '✔ all checks passed (oxlint, oxfmt, tsc)',
    '✔ staged the fixes to src/spaced.ts',
  ]
}

describe.each(LAYOUTS)('committing with the prepared hook in a $name', ({ create, app, tsc }) => {
  it('blocks a commit with a lint error it cannot fix', async () => {
    const project = create({ '.oxlintrc.json': LINT_CONFIG })
    await prepare(project, [], { cwd: app })
    project.stage({ [`${app}src/ignore.ts`]: UNFIXABLE })

    const { exitCode, stderr } = await commit(project, 'ignore')

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual(blockedByLint(project.path(app, '.'), tsc))
    expect(project.git('log', '--format=%s')).toBe('init\n')
    expect(project.git('diff', '--cached', '--name-only')).toBe(`${app}src/ignore.ts\n`)
  })

  it('commits the fixes it applied', async () => {
    const project = create()
    await prepare(project, [], { cwd: app })
    project.stage({ [`${app}src/spaced.ts`]: 'export var spaced   =   1\n' })

    const { exitCode, stderr } = await commit(project, 'spaced')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual(fixedAndStaged(project.path(app, '.'), tsc))
    expect(project.git('log', '--format=%s')).toBe('spaced\ninit\n')
    expect(project.git('show', `HEAD:${app}src/spaced.ts`)).toBe('export const spaced = 1;\n')
    expect(project.read(`${app}src/spaced.ts`)).toBe('export const spaced = 1;\n')
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('runs through the husky 9 dispatcher before the commands of the hook', async () => {
    const project = installHusky(create(), 'echo "husky hook ran"\n')
    await prepare(project, [], { cwd: app })
    project.commit('husky')
    project.stage({ [`${app}src/spaced.ts`]: 'export const spaced   =   1\n' })

    const { exitCode, stderr } = await commit(project, 'spaced')

    expect(exitCode).toBe(0)
    expect(report(stderr)).toEqual(fixedAndStaged(project.path(app, '.'), tsc))
    expect(stderr).toMatch(/\nhusky hook ran\n$/)
    expect(project.git('show', `HEAD:${app}src/spaced.ts`)).toBe('export const spaced = 1;\n')
  })
})

describe('committing with the prepared hook of several packages in a monorepo', () => {
  it('stops at the first package whose line fails', async () => {
    const project = monorepo({ '.oxlintrc.json': LINT_CONFIG })
    await prepare(project, [], { cwd: 'packages/core' })
    await prepare(project, [], { cwd: 'packages/app' })
    project.stage({
      'packages/core/src/ignore.ts': UNFIXABLE,
      'packages/app/src/spaced.ts': 'export const spaced   =   1\n',
    })

    const { exitCode, stderr } = await commit(project, 'both')

    expect(exitCode).toBe(1)
    expect(report(stderr)).toEqual(
      blockedByLint(project.path('packages/core'), TSC_WITHOUT_REFERENCES),
    )
    expect(project.read('packages/app/src/spaced.ts')).toBe('export const spaced   =   1\n')
    expect(project.git('log', '--format=%s')).toBe('init\n')
  })
})
