import { LAYOUTS, cliError, singleRepo } from '../../utils/project'
import {
  asWritten,
  claudeSettings,
  copilotHooks,
  cursorHooks,
  hookCommand,
  installOutput,
} from './utils'

describe.each(LAYOUTS)('hooks install writes the agent configs in a $name', ({ create, app }) => {
  it('writes the stop hook of Claude Code, CodeBuddy and Cursor into the package', async () => {
    const project = create()
    const command = hookCommand(app)

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['hooks', 'install', 'cursor', 'claude', 'codebuddy'],
      { cwd: app },
    )

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(
      installOutput(
        [
          'Claude Code .claude/settings.json created',
          'CodeBuddy .codebuddy/settings.json created',
          'Cursor .cursor/hooks.json created',
        ],
        command,
      ),
    )
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
    expect(project.read(`${app}.codebuddy/settings.json`)).toBe(asWritten(claudeSettings(command)))
    expect(project.read(`${app}.cursor/hooks.json`)).toBe(asWritten(cursorHooks(command)))
    expect(project.exists(`${app}.github`)).toBe(false)
  })

  it('leaves an installed hook as it is when run again', async () => {
    const command = hookCommand(app)
    const compact = JSON.stringify(cursorHooks(command))
    const project = create({ [`${app}.cursor/hooks.json`]: compact })

    await project.uncheck(['hooks', 'install', 'claude'], { cwd: app })

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], {
      cwd: app,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      installOutput(
        ['Claude Code .claude/settings.json unchanged', 'Cursor .cursor/hooks.json unchanged'],
        command,
      ),
    )
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
    expect(project.read(`${app}.cursor/hooks.json`)).toBe(compact)
  })

  it('writes the check selection into the hook and updates it in place when it changes', async () => {
    const project = create()
    const flags = ['--only=oxlint', '--only=oxfmt', '--require=oxfmt', '--skip=tsc']
    const fast = hookCommand(app, flags)

    const first = await project.uncheck(['hooks', 'install', 'claude', 'cursor', ...flags], {
      cwd: app,
    })

    expect(first.exitCode).toBe(0)
    expect(first.stdout).toBe(
      installOutput(
        ['Claude Code .claude/settings.json created', 'Cursor .cursor/hooks.json created'],
        fast,
      ),
    )
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(fast)))
    expect(project.read(`${app}.cursor/hooks.json`)).toBe(asWritten(cursorHooks(fast)))

    const command = hookCommand(app)
    const second = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], { cwd: app })

    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe(
      installOutput(
        ['Claude Code .claude/settings.json updated', 'Cursor .cursor/hooks.json updated'],
        command,
      ),
    )
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
    expect(project.read(`${app}.cursor/hooks.json`)).toBe(asWritten(cursorHooks(command)))
  })
})

describe('hooks install for GitHub Copilot', () => {
  it('writes the GitHub Copilot hook at the top of the repository', async () => {
    const project = singleRepo()
    const command = hookCommand('')

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'copilot'])

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      installOutput(['GitHub Copilot .github/hooks/uncheck.json created'], command),
    )
    expect(project.read('.github/hooks/uncheck.json')).toBe(asWritten(copilotHooks(command)))
  })
})

describe('hooks install arguments', () => {
  it.each([
    [['--require=tsc', '--skip=tsc'], '--require=tsc and --skip=tsc contradict each other.'],
    [['--only=oxlint', '--skip=oxlint'], '--only=oxlint and --skip=oxlint contradict each other.'],
    [
      ['--only=oxlint', '--only=oxfmt', '--require=tsc'],
      '--require=tsc and --only=oxlint --only=oxfmt contradict each other.',
    ],
  ])('refuses the contradicting flags %j', async (flags, message) => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await project.uncheck([
      'hooks',
      'install',
      'claude',
      ...flags,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(cliError(message))
    expect(project.exists('.claude')).toBe(false)
  })

  it('refuses an agent it does not know, showing the usage', async () => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await project.uncheck([
      'hooks',
      'install',
      'claude',
      'emacs',
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toContain('USAGE\n  uncheck hooks install [flags] [<agents...>]\n')
    expect(stderr).toBe(
      cliError(
        'Invalid value for argument <agents>: "emacs". Expected: "claude" | "codebuddy" | "cursor" | "copilot"',
      ),
    )
    expect(project.exists('.claude')).toBe(false)
  })
})
