import { LAYOUTS } from '../../utils/project'
import {
  CLAUDE_CODE_STOP,
  CLAUDE_CODE_STOP_AGAIN,
  COPILOT_AGENT_STOP,
  COPILOT_STOP_IN_CLAUDE_FORMAT,
  CURSOR_STOP,
  TYPE_ERROR,
  lines,
  location,
  stopHook,
  tscCommand,
} from './utils'

const DIAGNOSTIC =
  "src/index.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'."

describe.each(LAYOUTS)(
  'hooks run sends each agent back its own way in a $name',
  ({ create, app }) => {
    const failing = () =>
      create({}, { tools: ['sherif', 'oxlint', 'oxfmt'] })
        .fake('typescript', `console.log(${JSON.stringify(DIAGNOSTIC)})\nprocess.exitCode = 2\n`)
        .write({ [`${app}src/index.ts`]: TYPE_ERROR })
    const failure = [
      `uncheck in ${location(app)}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern src/index.ts',
      '✔ oxfmt passed',
      tscCommand(app),
      '✘ tsc failed',
      '✘ 1 of 3 checks failed: tsc',
    ]
    const reason = (stderr: string) =>
      `uncheck found problems, fix them before finishing:\n\n${stderr.replace(/\n$/, '')}`

    it('blocks Claude Code and CodeBuddy with exit code 2 and the report on stderr', async () => {
      const project = failing()

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP)

      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(lines(project, stderr)).toEqual(failure)
      expect(stderr).toContain(`\n${DIAGNOSTIC}\n`)
    })

    it('lets Claude Code stop once it already went back, telling the user what still fails', async () => {
      const project = failing()

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP_AGAIN)

      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        systemMessage: 'uncheck still fails: 1 of 3 checks failed: tsc',
      })
      expect(lines(project, stderr)).toEqual(failure)
    })

    it('sends Cursor a follow-up message with the report', async () => {
      const project = failing()

      const { exitCode, stdout, stderr } = await stopHook(project, app, CURSOR_STOP)

      expect(exitCode).toBe(0)
      expect(lines(project, stderr)).toEqual(failure)
      expect(JSON.parse(stdout)).toEqual({ followup_message: reason(stderr) })
    })

    it('lets Cursor stop once it already followed up', async () => {
      const project = failing()

      const { exitCode, stdout, stderr } = await stopHook(project, app, {
        ...CURSOR_STOP,
        loop_count: 1,
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(lines(project, stderr)).toEqual(failure)
    })

    it('blocks Copilot with a decision, whichever payload format it sends', async () => {
      const project = failing()

      for (const payload of [COPILOT_AGENT_STOP, COPILOT_STOP_IN_CLAUDE_FORMAT]) {
        const { exitCode, stdout, stderr } = await stopHook(project, app, payload)

        expect(exitCode).toBe(0)
        expect(lines(project, stderr)).toEqual(failure)
        expect(JSON.parse(stdout)).toEqual({ decision: 'block', reason: reason(stderr) })
      }
    })

    it('only reports to an agent it does not know', async () => {
      const project = failing()

      const { exitCode, stdout, stderr } = await stopHook(project, app, {
        hook_event_name: 'SubagentStop',
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(lines(project, stderr)).toEqual(failure)
    })
  },
)
