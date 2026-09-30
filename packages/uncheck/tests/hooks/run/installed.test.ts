import type { Project, Run } from '../../utils/project'
import { LAYOUTS, run } from '../../utils/project'
import {
  CLAUDE_CODE_STOP,
  CLAUDE_CODE_STOP_AGAIN,
  CURSOR_STOP,
  GITIGNORE,
  TYPE_ERROR,
  lines,
  location,
  tscCommand,
} from './utils'

interface ClaudeSettings {
  readonly hooks: {
    readonly Stop: ReadonlyArray<{ readonly hooks: [{ readonly command: string }] }>
  }
}

interface CursorHooks {
  readonly hooks: { readonly stop: ReadonlyArray<{ readonly command: string }> }
}

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
    run(['sh', '-c', command], { cwd: project.path(`${app}src`), input: JSON.stringify(payload) })
}

describe.each(LAYOUTS)('the installed stop hook in a $name', ({ create, app }) => {
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

  it('sends Claude Code back until its change passes, from wherever it moved to', async () => {
    const project = create(GITIGNORE)
    const stop = await installHook(project, app, 'claude')

    project.commit('hook').write({ [`${app}src/index.ts`]: TYPE_ERROR })

    const blocked = await stop(CLAUDE_CODE_STOP)

    expect(blocked.exitCode).toBe(2)
    expect(blocked.stdout).toBe('')
    expect(lines(project, blocked.stderr)).toEqual(failure)

    const again = await stop(CLAUDE_CODE_STOP_AGAIN)

    expect(again.exitCode).toBe(0)
    expect(JSON.parse(again.stdout)).toEqual({
      systemMessage: 'uncheck still fails: 1 of 3 checks failed: tsc',
    })

    project.write({ [`${app}src/index.ts`]: 'export const   answer: string = "42"\n' })

    const passed = await stop(CLAUDE_CODE_STOP)

    expect(passed.exitCode).toBe(0)
    expect(passed.stdout).toBe('')
    expect(lines(project, passed.stderr).at(-1)).toBe('✔ all checks passed (oxlint, oxfmt, tsc)')
    expect(project.read(`${app}src/index.ts`)).toBe('export const answer: string = "42";\n')
  })

  it('sends Cursor back once with a follow-up message, from wherever it moved to', async () => {
    const project = create(GITIGNORE)
    const stop = await installHook(project, app, 'cursor')

    project.commit('hook').write({ [`${app}src/index.ts`]: TYPE_ERROR })

    const followUp = await stop(CURSOR_STOP)

    expect(followUp.exitCode).toBe(0)
    expect(lines(project, followUp.stderr)).toEqual(failure)
    expect(JSON.parse(followUp.stdout)).toEqual({
      followup_message: `uncheck found problems, fix them before finishing:\n\n${followUp.stderr.replace(/\n$/, '')}`,
    })

    const again = await stop({ ...CURSOR_STOP, loop_count: 1 })

    expect(again.exitCode).toBe(0)
    expect(again.stdout).toBe('')
    expect(lines(project, again.stderr)).toEqual(failure)
  })
})
