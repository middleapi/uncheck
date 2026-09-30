import { createProject, eachLayout } from '../../_shared/project'
import { CLAUDE_STOP, hookOf, sh } from '../shell'

const BROKEN = 'export const   answer: string = 1\n'
const FORMATTED = 'export const answer: string = 1\n'
const FIXED = "export const answer: string = '1'\n"

eachLayout('$layout', ({ layout }) => {
  it('runs the installed hooks the way each agent does and sends it back to fix its turn', async () => {
    const project = createProject(layout)
    const file = project.inApp('src/index.ts')

    await project.run(['hooks', 'install', 'claude', 'codebuddy', 'cursor', 'copilot'])

    const hooks = {
      claude: hookOf(project, 'claude'),
      codebuddy: hookOf(project, 'codebuddy'),
      cursor: hookOf(project, 'cursor'),
      copilot: hookOf(project, 'copilot'),
    }

    project.write({ [file]: BROKEN })

    const claude = await sh(project, hooks.claude, { stdin: CLAUDE_STOP })

    expect(claude.code).toBe(2)
    expect(claude.stdout).toBe('')
    expect(claude.stderr).toContain(`uncheck in ${project.root}\n`)
    expect(claude.stderr).toContain('▶ oxfmt --no-error-on-unmatched-pattern [5 files]\n')
    expect(claude.stderr).toContain(
      "error TS2322: Type 'number' is not assignable to type 'string'",
    )
    expect(claude.stderr).toContain('✘ 1 of 3 checks failed: tsc\n')
    expect(project.read(file)).toBe(FORMATTED)

    // Wherever the agent moved to, the hook checks the whole repository.
    const moved = await sh(project, hooks.claude, { cwd: project.inApp('src'), stdin: CLAUDE_STOP })

    expect(moved.code).toBe(2)
    expect(moved.stderr).toContain(`uncheck in ${project.root}\n`)

    const continuing = await sh(project, hooks.claude, {
      stdin: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }),
    })

    expect(continuing.code).toBe(0)
    expect(JSON.parse(continuing.stdout)).toEqual({
      systemMessage: 'uncheck still fails: 1 of 3 checks failed: tsc',
    })

    const codebuddy = await sh(project, hooks.codebuddy, { stdin: CLAUDE_STOP })

    expect(codebuddy.code).toBe(2)
    expect(codebuddy.stderr).toContain('TS2322')

    const cursor = await sh(project, hooks.cursor, {
      stdin: JSON.stringify({ hook_event_name: 'stop', status: 'completed', loop_count: 0 }),
    })

    expect(cursor.code).toBe(0)
    expect(JSON.parse(cursor.stdout).followup_message).toMatch(
      /^uncheck found problems, fix them before finishing:\n\n[^]*TS2322/,
    )

    const copilot = await sh(project, hooks.copilot, {
      stdin: JSON.stringify({ timestamp: 1, cwd: project.root, stopReason: 'end_turn' }),
    })

    expect(copilot.code).toBe(0)
    expect(JSON.parse(copilot.stdout)).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('TS2322'),
    })

    project.write({ [file]: FIXED })

    const fixed = await sh(project, hooks.claude, { stdin: CLAUDE_STOP })

    expect(fixed.code).toBe(0)
    expect(fixed.stdout).toBe('')
    expect(fixed.stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)\n')
  })
})
