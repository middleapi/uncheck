import { LAYOUTS, singleRepo } from '../../utils/project'
import { CLAUDE_CODE_STOP, TYPE_ERROR, lines, location, stopHook } from './utils'

describe.each(LAYOUTS)('hooks run passes the check selection on in a $name', ({ create, app }) => {
  it('skips a check with --skip', async () => {
    const project = create().write({
      [`${app}src/index.ts`]: TYPE_ERROR,
      [`${app}src/extra.ts`]: 'export const   extra = 1\n',
    })

    const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
      args: ['--fix', '--skip=tsc', '--skip=oxlint'],
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(lines(project, stderr)).toEqual([
      `uncheck in ${location(app)}`,
      '○ sherif skipped, no package.json among the given files',
      '○ oxlint skipped, disabled with --skip=oxlint',
      '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts src/index.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, disabled with --skip=tsc',
      '✔ all checks passed (oxfmt)',
    ])
    expect(project.read(`${app}src/extra.ts`)).toBe('export const extra = 1;\n')
  })

  it('passes a change no check selected with --only covers, unless it is required', async () => {
    const project = create().write({ [`${app}README.md`]: '# App\n' })

    const optional = await stopHook(project, app, CLAUDE_CODE_STOP, {
      args: ['--fix', '--only=tsc'],
    })

    expect(optional.exitCode).toBe(0)
    expect(optional.stdout).toBe('')
    expect(lines(project, optional.stderr)).toEqual([
      `uncheck in ${location(app)}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, not selected by --only',
      '○ tsc skipped, no tsconfig.json covers the given files',
      '○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files',
    ])

    const required = await stopHook(project, app, CLAUDE_CODE_STOP, {
      args: ['--fix', '--only=tsc', '--require=tsc'],
    })

    expect(required.exitCode).toBe(2)
    expect(required.stdout).toBe('')
    expect(lines(project, required.stderr)).toEqual([
      `uncheck in ${location(app)}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, not selected by --only',
      '✘ tsc no tsconfig.json covers the given files',
      '✘ 1 of 1 checks failed: tsc',
    ])
  })
})

describe('hooks run check selection', () => {
  it('refuses contradicting flags once there is something to check', async () => {
    const project = singleRepo()

    const unchanged = await stopHook(project, '', CLAUDE_CODE_STOP, {
      args: ['--only=tsc', '--skip=tsc'],
    })

    expect(unchanged.exitCode).toBe(0)
    expect(unchanged.stderr).toBe('')

    project.write({ 'src/extra.ts': 'export const extra = 1;\n' })

    const changed = await stopHook(project, '', CLAUDE_CODE_STOP, {
      args: ['--only=tsc', '--skip=tsc'],
    })

    expect(changed.exitCode).toBe(1)
    expect(changed.stdout).toBe('')
    expect(changed.stderr).toBe('\nERROR\n  --only=tsc and --skip=tsc contradict each other.\n')
  })
})
