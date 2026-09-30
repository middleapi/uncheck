import { LAYOUTS, cliError, monorepo } from '../../utils/project'
import { asWritten, claudeSettings, cursorHooks, hookCommand, installOutput } from './utils'

const QUESTION = 'Which agents should run uncheck when they finish a turn?'
const CHOICES = `? ${QUESTION} › \n  Select All\n  Inverse Selection\n  ☐ Claude Code \n  ☐ CodeBuddy \n  ☐ Cursor \n  ☐ GitHub Copilot `
const DOWN = '\u001B[B'
const SPACE = ' '
const ENTER = '\r'

function fromAnswer(output: string): string {
  return output.slice(output.lastIndexOf(`✔ ${QUESTION}`))
}

describe.each(LAYOUTS)('hooks install without agents in a $name', ({ create, app }) => {
  it('writes the agents chosen in a terminal', async () => {
    const project = create()
    const command = hookCommand(app)

    const { exitCode, stdout } = await project.uncheckInTerminal(['hooks', 'install'], {
      cwd: app,
      waitFor: QUESTION,
      keys: [DOWN, DOWN, SPACE, DOWN, DOWN, SPACE, ENTER],
    })

    expect(exitCode).toBe(0)
    expect(stdout.slice(0, CHOICES.length)).toBe(CHOICES)
    expect(fromAnswer(stdout)).toBe(
      `✔ ${QUESTION} …  Claude Code, Cursor\n${installOutput(
        ['Claude Code .claude/settings.json created', 'Cursor .cursor/hooks.json created'],
        command,
      )}`,
    )
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
    expect(project.read(`${app}.cursor/hooks.json`)).toBe(asWritten(cursorHooks(command)))
    expect(project.exists(`${app}.codebuddy`)).toBe(false)
  })

  it('asks for the agents on the command line when stdin is not a terminal', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck(['hooks', 'install'], { cwd: app })

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError(
        'Pass the agents to configure, for example: uncheck hooks install claude codebuddy cursor copilot',
      ),
    )
    expect(project.exists(`${app}.claude`)).toBe(false)
  })
})

describe('hooks install without agents in a monorepo package', () => {
  it('refuses Copilot chosen in a terminal, writing none of the others', async () => {
    const project = monorepo()

    const { exitCode, stdout } = await project.uncheckInTerminal(['hooks', 'install'], {
      cwd: 'packages/app',
      waitFor: QUESTION,
      keys: [SPACE, ENTER],
    })

    expect(exitCode).toBe(1)
    expect(fromAnswer(stdout)).toBe(
      `✔ ${QUESTION} …  Claude Code, CodeBuddy, Cursor, GitHub Copilot\n${cliError(
        'Copilot reads .github/hooks only at the top of the repository, not in packages/app: install copilot from there',
      )}`,
    )
    expect(project.exists('packages/app/.claude')).toBe(false)
    expect(project.exists('packages/app/.github')).toBe(false)
  })
})
