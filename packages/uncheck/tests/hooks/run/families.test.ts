import type { Project, Run } from '../../utils/project'
import { LAYOUTS, report, run } from '../../utils/project'
import {
  CLAUDE_CODE_STOP,
  CLAUDE_CODE_STOP_AGAIN,
  COPILOT_AGENT_STOP,
  COPILOT_STOP_IN_CLAUDE_FORMAT,
  CURSOR_STOP,
  TYPE_ERROR,
  stopHook,
} from './utils'

interface ClaudeSettings {
  readonly hooks: {
    readonly Stop: ReadonlyArray<{ readonly hooks: [{ readonly command: string }] }>
  }
}

interface CursorHooks {
  readonly hooks: { readonly stop: ReadonlyArray<{ readonly command: string }> }
}

const DOCS = { 'docs/guide.md': '# Guide\n' }

const DIAGNOSTIC =
  "src/index.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'."

async function installHook(
  project: Project,
  app: string,
  agent: 'claude' | 'cursor',
): Promise<(payload: object) => Promise<Run>> {
  const install = await project.uncheck(['hooks', 'install', agent], { cwd: app })

  expect(install.exitCode).toBe(0)

  const command =
    agent === 'claude'
      ? (JSON.parse(project.read(`${app}.claude/settings.json`)) as ClaudeSettings).hooks.Stop[0]!
          .hooks[0].command
      : (JSON.parse(project.read(`${app}.cursor/hooks.json`)) as CursorHooks).hooks.stop[0]!.command

  return (payload) =>
    run(['sh', '-c', command], { cwd: project.path('docs'), input: JSON.stringify(payload) })
}

function sendBackReason(stderr: string): string {
  return `uncheck found problems, fix them before finishing:\n\n${stderr.replace(/\n$/, '')}`
}

describe.each(LAYOUTS)(
  'hooks run sends each agent back its own way in a $name',
  ({ create, app, tsc }) => {
    const checks = (project: Project, ...outcome: ReadonlyArray<string>) => [
      `uncheck in ${project.path(app, '.')}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern src/index.ts',
      '✔ oxfmt passed',
      tsc,
      ...outcome,
    ]
    const failure = (project: Project) =>
      checks(project, '✘ tsc failed', '✘ 1 of 3 checks failed: tsc')

    it('blocks Claude Code with exit code 2 until its change passes, through its hook run from outside the change', async () => {
      const project = create(DOCS)
      const stop = await installHook(project, app, 'claude')

      project.commit('hook').write({ [`${app}src/index.ts`]: TYPE_ERROR })

      const blocked = await stop(CLAUDE_CODE_STOP)

      expect(blocked.exitCode).toBe(2)
      expect(blocked.stdout).toBe('')
      expect(report(blocked.stderr)).toEqual(failure(project))
      expect(blocked.stderr).toContain(`\n${DIAGNOSTIC}\n`)

      const again = await stop(CLAUDE_CODE_STOP_AGAIN)

      expect(again.exitCode).toBe(0)
      expect(JSON.parse(again.stdout)).toEqual({
        systemMessage: 'uncheck still fails: 1 of 3 checks failed: tsc',
      })
      expect(report(again.stderr)).toEqual(failure(project))

      project.write({ [`${app}src/index.ts`]: 'export const   answer: string = "42"\n' })

      const passed = await stop(CLAUDE_CODE_STOP)

      expect(passed.exitCode).toBe(0)
      expect(passed.stdout).toBe('')
      expect(report(passed.stderr)).toEqual(
        checks(project, '✔ tsc passed', '✔ all checks passed (oxlint, oxfmt, tsc)'),
      )
      expect(project.read(`${app}src/index.ts`)).toBe('export const answer: string = "42";\n')
    })

    it('sends Cursor back once with a follow-up message, through its hook run from outside the change', async () => {
      const project = create(DOCS)
      const stop = await installHook(project, app, 'cursor')

      project.commit('hook').write({ [`${app}src/index.ts`]: TYPE_ERROR })

      const followUp = await stop(CURSOR_STOP)

      expect(followUp.exitCode).toBe(0)
      expect(report(followUp.stderr)).toEqual(failure(project))
      expect(JSON.parse(followUp.stdout)).toEqual({
        followup_message: sendBackReason(followUp.stderr),
      })

      const again = await stop({ ...CURSOR_STOP, loop_count: 1 })

      expect(again.exitCode).toBe(0)
      expect(again.stdout).toBe('')
      expect(report(again.stderr)).toEqual(failure(project))
    })

    it('blocks Copilot with a decision, whichever payload format it sends', async () => {
      const project = create().write({ [`${app}src/index.ts`]: TYPE_ERROR })

      for (const payload of [COPILOT_AGENT_STOP, COPILOT_STOP_IN_CLAUDE_FORMAT]) {
        const { exitCode, stdout, stderr } = await stopHook(project, app, payload)

        expect(exitCode).toBe(0)
        expect(report(stderr)).toEqual(failure(project))
        expect(JSON.parse(stdout)).toEqual({ decision: 'block', reason: sendBackReason(stderr) })
      }
    })
  },
)
