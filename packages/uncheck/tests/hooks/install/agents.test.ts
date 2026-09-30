import { createProject, eachLayout } from '../../_shared/project'

const HOOK = 'npx --no uncheck hooks run --fix'

eachLayout('$layout', ({ layout }) => {
  it('writes a stop hook config for every agent named, through the package manager of the project', async () => {
    const project = createProject(layout)

    const { code, stdout, stderr } = await project.run([
      'hooks',
      'install',
      'claude',
      'codebuddy',
      'cursor',
      'copilot',
    ])

    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout).toBe(
      [
        '✔ Claude Code .claude/settings.json created',
        '✔ CodeBuddy .codebuddy/settings.json created',
        '✔ Cursor .cursor/hooks.json created',
        '✔ GitHub Copilot .github/hooks/uncheck.json created',
        '',
        `The hook runs ${HOOK} whenever the agent finishes a turn.`,
        '',
      ].join('\n'),
    )

    const claude = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK, timeout: 600 }] }] },
    }

    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual(claude)
    expect(JSON.parse(project.read('.codebuddy/settings.json'))).toEqual(claude)
    expect(JSON.parse(project.read('.cursor/hooks.json'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: HOOK, timeout: 600 }] },
    })
    expect(JSON.parse(project.read('.github/hooks/uncheck.json'))).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: HOOK, powershell: HOOK, timeoutSec: 600 }] },
    })
    expect(project.read('.cursor/hooks.json')).toBe(
      `${JSON.stringify(JSON.parse(project.read('.cursor/hooks.json')), null, 2)}\n`,
    )

    const again = await project.run([
      'hooks',
      'install',
      'cursor',
      'claude',
      'copilot',
      'codebuddy',
    ])

    expect(again.code).toBe(0)
    expect(again.stdout).toContain(
      [
        '✔ Claude Code .claude/settings.json unchanged',
        '✔ CodeBuddy .codebuddy/settings.json unchanged',
        '✔ Cursor .cursor/hooks.json unchanged',
        '✔ GitHub Copilot .github/hooks/uncheck.json unchanged',
      ].join('\n'),
    )
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual(claude)
  })

  it('writes the check selection into the hook command and drops it on a reinstall without', async () => {
    const project = createProject(layout)
    const selected = `${HOOK} --only=oxlint --only=oxfmt --require=oxfmt --skip=sherif`

    const { code, stdout } = await project.run([
      'hooks',
      'install',
      'claude',
      'copilot',
      '--skip=sherif',
      '--only=oxlint',
      '--require=oxfmt',
      '--only=oxfmt',
    ])

    expect(code).toBe(0)
    expect(stdout).toContain(`The hook runs ${selected} whenever the agent finishes a turn.`)
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: selected, timeout: 600 }] }] },
    })

    const again = await project.run(['hooks', 'install', 'claude', 'copilot'])

    expect(again.code).toBe(0)
    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(again.stdout).toContain('✔ GitHub Copilot .github/hooks/uncheck.json updated\n')
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK, timeout: 600 }] }] },
    })
    expect(JSON.parse(project.read('.github/hooks/uncheck.json'))).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: HOOK, powershell: HOOK, timeoutSec: 600 }] },
    })
  })

  it('refuses a contradictory selection, an unknown agent and a missing one without a terminal', async () => {
    const project = createProject(layout)

    const contradiction = await project.run([
      'hooks',
      'install',
      'claude',
      '--only=oxlint',
      '--skip=oxlint',
    ])

    expect(contradiction.code).toBe(1)
    expect(contradiction.stderr).toMatch(/--only=oxlint and --skip=oxlint/)

    const unknown = await project.run(['hooks', 'install', 'emacs'])

    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('emacs')

    const none = await project.run(['hooks', 'install', '--require=tsc'])

    expect(none.code).toBe(1)
    expect(none.stderr).toContain(
      'Pass the agents to configure, for example: uncheck hooks install claude codebuddy cursor copilot',
    )
    expect(project.exists('.claude')).toBe(false)
    expect(project.git('status', '--porcelain')).toBe('')
  })
})

it('lists its subcommands under `uncheck hooks --help`', async () => {
  const project = createProject('single', { tools: [], git: false })

  const { code, stdout } = await project.run(['hooks', '--help'])

  expect(code).toBe(0)
  expect(stdout).toContain('install')
  expect(stdout).toContain('run')
})
