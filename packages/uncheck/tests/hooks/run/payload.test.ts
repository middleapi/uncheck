import { LAYOUTS, cliError, report } from '../../utils/project'
import { CURSOR_STOP, dirFlags, stopHook } from './utils'

const UNFORMATTED = 'export const   answer = 42\n'

describe.each(LAYOUTS)('hooks run reads the payload in a $name', ({ create, app }) => {
  it('refuses a terminal on stdin, where no agent sends a payload', async () => {
    const project = create().write({ [`${app}src/index.ts`]: UNFORMATTED })

    const { exitCode, stdout } = await project.uncheckInTerminal([
      'hooks',
      'run',
      '--fix',
      ...dirFlags(app),
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toBe(
      cliError('`uncheck hooks run` expects the agent hook payload as JSON on stdin'),
    )
    expect(project.read(`${app}src/index.ts`)).toBe(UNFORMATTED)
  })

  it('only reports through a payload from an agent it does not know, or one that is empty, not JSON or not an object', async () => {
    const project = create().write({ [`${app}src/index.ts`]: UNFORMATTED })

    for (const payload of [
      { hook_event_name: 'SubagentStop' },
      '',
      '{"hook_event_name": "Stop"',
      'null',
      '["Stop"]',
    ]) {
      const { exitCode, stdout, stderr } = await stopHook(project, app, payload, {
        args: ['--only=oxfmt'],
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '▶ oxfmt --check --no-error-on-unmatched-pattern src/index.ts',
        '✘ oxfmt failed',
        '○ tsc skipped, not selected by --only',
        '○ fallow skipped, not selected by --only',
        '✘ 1 of 1 checks failed: oxfmt',
        '  rerun with `--fix` to apply oxfmt fixes',
      ])
    }
  })

  it('leaves a turn the user stopped, or that failed, as it is', async () => {
    const project = create().write({ [`${app}src/index.ts`]: UNFORMATTED })

    for (const status of ['aborted', 'error']) {
      const { exitCode, stdout, stderr } = await stopHook(project, app, { ...CURSOR_STOP, status })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
    }

    expect(project.read(`${app}src/index.ts`)).toBe(UNFORMATTED)
  })
})
