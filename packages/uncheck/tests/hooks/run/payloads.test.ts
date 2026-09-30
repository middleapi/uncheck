import { createProject, eachLayout } from '../../_shared/project'
import { CLAUDE_STOP } from '../shell'

const BROKEN = 'export const   answer: string = 1\n'
const FORMATTED = 'export const answer: string = 1\n'

eachLayout('$layout', ({ layout }) => {
  function broken() {
    const project = createProject(layout)
    const file = project.inApp('src/index.ts')

    project.write({ [file]: BROKEN, [project.inApp('src/fresh.ts')]: 'export const fresh = 3\n' })

    return { project, file }
  }

  it('fixes what it can and blocks a Claude Code or CodeBuddy stop with exit code 2', async () => {
    const { project, file } = broken()

    const { code, stdout, stderr } = await project.run(['hooks', 'run', '--fix'], {
      stdin: CLAUDE_STOP,
    })

    expect(code).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toContain(`uncheck in ${project.root}\n`)
    expect(stderr).toContain(
      `▶ oxlint --fix --no-error-on-unmatched-pattern ${project.inApp('src/fresh.ts')} ${file}\n`,
    )
    expect(stderr).toContain(
      `▶ tsc -p ${project.inApp('tsconfig.json')} --noEmit\n${file}(1,14): error TS2322`,
    )
    expect(stderr).toMatch(/✘ 1 of 3 checks failed: tsc\n$/)
    expect(project.read(file)).toBe(FORMATTED)

    // Once the agent is already continuing, the user sees why, and the turn ends.
    const continuing = await project.run(['hooks', 'run', '--fix'], {
      stdin: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }),
    })

    expect(continuing.code).toBe(0)
    expect(JSON.parse(continuing.stdout)).toEqual({
      systemMessage: 'uncheck still fails: 1 of 3 checks failed: tsc',
    })
    expect(continuing.stderr).toContain('TS2322')
  })

  it('sends Cursor back with a follow-up message, once', async () => {
    const { project } = broken()

    const first = await project.run(['hooks', 'run', '--fix'], {
      stdin: JSON.stringify({ hook_event_name: 'stop', status: 'completed', loop_count: 0 }),
    })

    expect(first.code).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({
      followup_message: expect.stringMatching(
        /^uncheck found problems, fix them before finishing:\n\nuncheck in [^]*TS2322[^]*✘ 1 of 3 checks failed: tsc$/,
      ),
    })
    expect(first.stderr).toContain('TS2322')

    const again = await project.run(['hooks', 'run', '--fix'], {
      stdin: JSON.stringify({ hook_event_name: 'stop', status: 'completed', loop_count: 1 }),
    })

    expect(again.code).toBe(0)
    expect(again.stdout).toBe('')
    expect(again.stderr).toContain('TS2322')
  })

  it('sends Copilot back with a block decision, in either payload format', async () => {
    const { project } = broken()

    for (const payload of [
      { timestamp: 1, cwd: project.root, stopReason: 'end_turn' },
      { hook_event_name: 'Stop', stop_reason: 'end_turn', stop_hook_active: false },
    ]) {
      const { code, stdout } = await project.run(['hooks', 'run', '--fix'], {
        stdin: JSON.stringify(payload),
      })

      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        decision: 'block',
        reason: expect.stringMatching(
          /^uncheck found problems, fix them before finishing:\n\n[^]*TS2322/,
        ),
      })
    }
  })

  it('only reports on stderr for a payload it does not recognise', async () => {
    const { project } = broken()

    for (const stdin of ['{}', 'not json', '[1, 2]']) {
      const { code, stdout, stderr } = await project.run(['hooks', 'run'], { stdin })

      expect(code).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toContain('✘ 2 of 3 checks failed: oxfmt, tsc\n')
    }
  })

  it('leaves a Cursor turn the user stopped, or that failed, alone', async () => {
    const { project, file } = broken()

    for (const status of ['aborted', 'error']) {
      const { code, stdout, stderr } = await project.run(['hooks', 'run', '--fix'], {
        stdin: JSON.stringify({ hook_event_name: 'stop', status, loop_count: 0 }),
      })

      expect(code).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
    }

    expect(project.read(file)).toBe(BROKEN)
  })
})
