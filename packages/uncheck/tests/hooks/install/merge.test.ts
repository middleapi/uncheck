import { createProject, eachLayout } from '../../_shared/project'

const HOOK = 'npx --no uncheck hooks run --fix'
const OWN = { type: 'command', command: HOOK, timeout: 600 }

eachLayout('$layout', ({ layout }) => {
  it('merges into existing settings with comments and trailing commas, keeping the other hooks', async () => {
    const project = createProject(layout, {
      files: {
        '.claude/settings.json': `{
  // keep me
  "permissions": { "allow": ["Bash(pnpm test)"] },
  "hooks": {
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo done" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }],
  },
}
`,
      },
    })
    const hook = `${HOOK} --require=tsc --skip=sherif`

    const { code, stdout } = await project.run([
      'hooks',
      'install',
      'codebuddy',
      'claude',
      '--require=tsc',
      '--skip=sherif',
    ])

    expect(code).toBe(0)
    expect(stdout).toContain(
      '✔ Claude Code .claude/settings.json updated\n✔ CodeBuddy .codebuddy/settings.json created\n',
    )
    expect(stdout).toContain(hook)
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual({
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo done' }] }],
        Stop: [
          { hooks: [{ type: 'command', command: 'notify-send done' }] },
          { hooks: [{ type: 'command', command: hook, timeout: 600 }] },
        ],
      },
    })
  })

  it('updates its own entry in place and leaves strings that only mention the hook alone', async () => {
    const mentions = {
      _comment: 'the Stop hook runs npx uncheck hooks run --fix',
      permissions: { allow: ['Bash(npx uncheck hooks run:*)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'cd packages/web && npx uncheck hooks run --fix && notify',
              },
              { type: 'command', command: 'npx uncheck hooks run --fix --only=oxfmt', timeout: 5 },
            ],
          },
        ],
      },
    }
    const project = createProject(layout, { files: { '.claude/settings.json': mentions } })

    const { code, stdout } = await project.run(['hooks', 'install', 'claude'])

    expect(code).toBe(0)
    expect(stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual({
      ...mentions,
      hooks: { ...mentions.hooks, Stop: [{ hooks: [OWN] }] },
    })

    // An older hook, in the shape and prefix of an earlier release, keeps what the user added to it.
    project.write({
      '.claude/settings.json': {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'npx uncheck hooks run --fix --only=oxlint',
                  statusMessage: 'Checking',
                },
              ],
            },
          ],
        },
      },
    })

    const upgraded = await project.run(['hooks', 'install', 'claude'])

    expect(upgraded.stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual({
      hooks: { Stop: [{ hooks: [{ ...OWN, statusMessage: 'Checking' }] }] },
    })

    const again = await project.run(['hooks', 'install', 'claude'])

    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')

    // A timeout the user chose stays, and Copilot takes `timeout` for `timeoutSec`.
    project.write({
      '.claude/settings.json': { hooks: { Stop: [{ hooks: [{ ...OWN, timeout: 1800 }] }] } },
      '.github/hooks/uncheck.json': {
        hooks: { agentStop: [{ bash: 'uncheck hooks run', timeout: 1800 }] },
      },
      '.cursor/hooks.json': {
        version: 1,
        hooks: { stop: [{ command: 'bunx uncheck hooks run --fix', timeoutSec: 60 }] },
      },
    })

    const raised = await project.run(['hooks', 'install', 'claude', 'copilot', 'cursor'])

    expect(raised.code).toBe(0)
    expect(raised.stdout).toContain(
      [
        '✔ Claude Code .claude/settings.json unchanged',
        '✔ Cursor .cursor/hooks.json updated',
        '✔ GitHub Copilot .github/hooks/uncheck.json updated',
      ].join('\n'),
    )
    expect(JSON.parse(project.read('.github/hooks/uncheck.json'))).toEqual({
      hooks: {
        agentStop: [{ type: 'command', bash: HOOK, powershell: HOOK, timeout: 1800 }],
      },
    })
    expect(JSON.parse(project.read('.cursor/hooks.json'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: HOOK, timeoutSec: 60 }] },
    })
  })

  it('replaces hooks that are not an object and events that are not a list', async () => {
    const project = createProject(layout, {
      files: {
        '.claude/settings.json': { model: 'opus', hooks: 'none' },
        '.cursor/hooks.json': { version: 1, hooks: { stop: { command: 'notify' }, start: 3 } },
      },
    })

    const { code, stdout } = await project.run(['hooks', 'install', 'claude', 'cursor'])

    expect(code).toBe(0)
    expect(stdout).toContain('✔ Claude Code .claude/settings.json updated\n')
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [OWN] }] },
    })
    expect(JSON.parse(project.read('.cursor/hooks.json'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: HOOK, timeout: 600 }], start: 3 },
    })
  })

  it('refuses a config that is not a JSON object and leaves every file as it is', async () => {
    const broken = '{\n  permissions: { "deny": ["Read(.env)"] },\n  "model": "opus"\n}\n'
    const project = createProject(layout, {
      files: { '.cursor/hooks.json': broken, '.github/hooks/uncheck.json': '[]' },
    })

    const invalid = await project.run(['hooks', 'install', 'claude', 'cursor'])

    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain(
      '.cursor/hooks.json has InvalidSymbol on line 2, fix it and run again',
    )

    const array = await project.run(['hooks', 'install', 'copilot'])

    expect(array.code).toBe(1)
    expect(array.stderr).toContain(
      '.github/hooks/uncheck.json is not a JSON object, fix it and run again',
    )
    expect(project.read('.cursor/hooks.json')).toBe(broken)
    expect(project.read('.github/hooks/uncheck.json')).toBe('[]')
    expect(project.exists('.claude/settings.json')).toBe(false)

    // An empty file counts as no settings yet.
    project.write({ '.cursor/hooks.json': '\n' })

    const empty = await project.run(['hooks', 'install', 'cursor'])

    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('✔ Cursor .cursor/hooks.json updated\n')
    expect(project.read('.cursor/hooks.json')).toBe(
      `${JSON.stringify({ version: 1, hooks: { stop: [{ command: HOOK, timeout: 600 }] } }, null, 2)}\n`,
    )
  })
})
