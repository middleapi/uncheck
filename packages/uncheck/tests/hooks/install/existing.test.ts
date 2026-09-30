import { LAYOUTS, cliError, singleRepo } from '../../utils/project'
import {
  TIMEOUT,
  asWritten,
  claudeSettings,
  cursorHooks,
  hookCommand,
  installOutput,
} from './utils'

const MENTIONS = [
  'cd web && npx uncheck hooks run --fix && notify',
  'npx uncheck hooks run --fix src',
  'npx uncheck hooks run-all --fix',
  'echo npx uncheck hooks run --fix',
]

describe.each(LAYOUTS)(
  'hooks install merges into existing configs in a $name',
  ({ create, app }) => {
    it('adds its hook to a JSONC config, keeping every other setting and hook', async () => {
      const project = create({
        [`${app}.claude/settings.json`]: `{
  // Shared with the team.
  "permissions": { "allow": ["Bash(pnpm test)"], },
  "hooks": {
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo done" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }],
  },
}
`,
        [`${app}.cursor/hooks.json`]: { hooks: { afterFileEdit: [{ command: 'echo edited' }] } },
      })
      const command = hookCommand(app)

      const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], {
        cwd: app,
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe(
        installOutput(
          ['Claude Code .claude/settings.json updated', 'Cursor .cursor/hooks.json updated'],
          command,
        ),
      )
      expect(project.read(`${app}.claude/settings.json`)).toBe(
        asWritten({
          permissions: { allow: ['Bash(pnpm test)'] },
          hooks: {
            PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo done' }] }],
            Stop: [
              { hooks: [{ type: 'command', command: 'notify-send done' }] },
              { hooks: [{ type: 'command', command, timeout: TIMEOUT }] },
            ],
          },
        }),
      )
      expect(project.read(`${app}.cursor/hooks.json`)).toBe(
        asWritten({
          hooks: {
            afterFileEdit: [{ command: 'echo edited' }],
            stop: [{ command, timeout: TIMEOUT }],
          },
          version: 1,
        }),
      )
    })

    it('replaces its own stop entry where it is, keeping what the user set on it', async () => {
      const postToolUse = [
        { hooks: [{ type: 'command', command: 'npx uncheck hooks run --fix --only=oxfmt' }] },
      ]
      const project = create({
        [`${app}.claude/settings.json`]: {
          hooks: {
            PostToolUse: postToolUse,
            Stop: [
              { hooks: [{ type: 'command', command: 'notify-send done' }] },
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: 'npx uncheck hooks run --fix --only=oxlint',
                    statusMessage: 'Checking',
                    timeout: 1800,
                  },
                ],
              },
              { hooks: [{ type: 'command', command: 'echo last' }] },
            ],
          },
        },
        [`${app}.cursor/hooks.json`]: {
          version: 2,
          hooks: { stop: [{ command: 'yarn uncheck hooks run' }, { command: 'echo last' }] },
        },
      })
      const command = hookCommand(app)

      const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], {
        cwd: app,
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe(
        installOutput(
          ['Claude Code .claude/settings.json updated', 'Cursor .cursor/hooks.json updated'],
          command,
        ),
      )
      expect(project.read(`${app}.claude/settings.json`)).toBe(
        asWritten({
          hooks: {
            PostToolUse: postToolUse,
            Stop: [
              { hooks: [{ type: 'command', command: 'notify-send done' }] },
              {
                matcher: '',
                hooks: [{ type: 'command', command, statusMessage: 'Checking', timeout: 1800 }],
              },
              { hooks: [{ type: 'command', command: 'echo last' }] },
            ],
          },
        }),
      )
      expect(project.read(`${app}.cursor/hooks.json`)).toBe(
        asWritten({
          version: 2,
          hooks: { stop: [{ command, timeout: TIMEOUT }, { command: 'echo last' }] },
        }),
      )

      const again = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], { cwd: app })

      expect(again.exitCode).toBe(0)
      expect(again.stdout).toBe(
        installOutput(
          ['Claude Code .claude/settings.json unchanged', 'Cursor .cursor/hooks.json unchanged'],
          command,
        ),
      )
    })

    it('leaves stop hooks that only mention it alone, adding its own next to them', async () => {
      const claudeStop = [
        {
          hooks: [
            ...MENTIONS.map((mention) => ({ type: 'command', command: mention })),
            {
              type: 'command',
              command: 'notify-send done',
              statusMessage: 'Waiting for uncheck hooks run --fix',
            },
          ],
        },
      ]
      const cursorStop = MENTIONS.map((mention) => ({ command: mention }))
      const project = create({
        [`${app}.claude/settings.json`]: { hooks: { Stop: claudeStop } },
        [`${app}.cursor/hooks.json`]: { hooks: { stop: cursorStop } },
      })
      const command = hookCommand(app)

      const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], {
        cwd: app,
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe(
        installOutput(
          ['Claude Code .claude/settings.json updated', 'Cursor .cursor/hooks.json updated'],
          command,
        ),
      )
      expect(project.read(`${app}.claude/settings.json`)).toBe(
        asWritten({
          hooks: {
            Stop: [...claudeStop, { hooks: [{ type: 'command', command, timeout: TIMEOUT }] }],
          },
        }),
      )
      expect(project.read(`${app}.cursor/hooks.json`)).toBe(
        asWritten({
          hooks: { stop: [...cursorStop, { command, timeout: TIMEOUT }] },
          version: 1,
        }),
      )

      const again = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], { cwd: app })

      expect(again.exitCode).toBe(0)
      expect(again.stdout).toBe(
        installOutput(
          ['Claude Code .claude/settings.json unchanged', 'Cursor .cursor/hooks.json unchanged'],
          command,
        ),
      )
    })

    it('replaces a stop event that is not a list of hooks', async () => {
      const project = create({
        [`${app}.claude/settings.json`]: { hooks: { Stop: 'notify-send done' } },
        [`${app}.cursor/hooks.json`]: { version: 1, hooks: { stop: { command: 'echo done' } } },
      })
      const command = hookCommand(app)

      const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude', 'cursor'], {
        cwd: app,
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe(
        installOutput(
          ['Claude Code .claude/settings.json updated', 'Cursor .cursor/hooks.json updated'],
          command,
        ),
      )
      expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
      expect(project.read(`${app}.cursor/hooks.json`)).toBe(asWritten(cursorHooks(command)))
    })

    it('writes a new config over an empty file or a hooks value that is not an object', async () => {
      const project = create({
        [`${app}.claude/settings.json`]: { model: 'opus', hooks: ['notify-send done'] },
        [`${app}.codebuddy/settings.json`]: '',
        [`${app}.cursor/hooks.json`]: ' \n\t\n',
      })
      const command = hookCommand(app)

      const { exitCode, stdout } = await project.uncheck(
        ['hooks', 'install', 'claude', 'codebuddy', 'cursor'],
        { cwd: app },
      )

      expect(exitCode).toBe(0)
      expect(stdout).toBe(
        installOutput(
          [
            'Claude Code .claude/settings.json updated',
            'CodeBuddy .codebuddy/settings.json updated',
            'Cursor .cursor/hooks.json updated',
          ],
          command,
        ),
      )
      expect(project.read(`${app}.claude/settings.json`)).toBe(
        asWritten({ model: 'opus', ...claudeSettings(command) }),
      )
      expect(project.read(`${app}.codebuddy/settings.json`)).toBe(
        asWritten(claudeSettings(command)),
      )
      expect(project.read(`${app}.cursor/hooks.json`)).toBe(asWritten(cursorHooks(command)))
    })

    it('refuses a config it cannot read as a JSON object and leaves every file as it is', async () => {
      const broken = '{\n  "version": 1,\n  hooks: {}\n}\n'
      const project = create({
        [`${app}.cursor/hooks.json`]: broken,
        [`${app}.claude/settings.json`]: '["Stop"]\n',
        [`${app}.codebuddy/settings.json`]: '"hooks"\n',
      })

      const cursor = await project.uncheck(['hooks', 'install', 'cursor'], { cwd: app })

      expect(cursor.exitCode).toBe(1)
      expect(cursor.stdout).toBe('')
      expect(cursor.stderr).toBe(
        cliError('.cursor/hooks.json has InvalidSymbol on line 3, fix it and run again'),
      )

      for (const [agent, file] of [
        ['claude', '.claude/settings.json'],
        ['codebuddy', '.codebuddy/settings.json'],
      ] as const) {
        const { exitCode, stdout, stderr } = await project.uncheck(['hooks', 'install', agent], {
          cwd: app,
        })

        expect(exitCode).toBe(1)
        expect(stdout).toBe('')
        expect(stderr).toBe(cliError(`${file} is not a JSON object, fix it and run again`))
      }

      expect(project.read(`${app}.cursor/hooks.json`)).toBe(broken)
      expect(project.read(`${app}.claude/settings.json`)).toBe('["Stop"]\n')
      expect(project.read(`${app}.codebuddy/settings.json`)).toBe('"hooks"\n')
    })

    it('writes no config when another one it was asked for is broken', async () => {
      const project = create({ [`${app}.cursor/hooks.json`]: '{ "version": 1' })

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['hooks', 'install', 'claude', 'cursor'],
        { cwd: app },
      )

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toBe(
        cliError('.cursor/hooks.json has CloseBraceExpected on line 1, fix it and run again'),
      )
      expect(project.exists(`${app}.claude`)).toBe(false)
    })
  },
)

describe('hooks install merges into an existing GitHub Copilot config', () => {
  it('keeps a Copilot timeout under either of its names', async () => {
    const project = singleRepo({
      '.github/hooks/uncheck.json': {
        version: 1,
        hooks: {
          agentStop: [
            { type: 'command', bash: 'npx uncheck hooks run --fix', timeout: 1800 },
            { type: 'command', powershell: 'npx uncheck hooks run --fix', timeoutSec: 1200 },
          ],
        },
      },
    })
    const command = hookCommand('')

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'copilot'])

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      installOutput(['GitHub Copilot .github/hooks/uncheck.json updated'], command),
    )
    expect(project.read('.github/hooks/uncheck.json')).toBe(
      asWritten({
        version: 1,
        hooks: {
          agentStop: [
            { type: 'command', bash: command, timeout: 1800, powershell: command },
            { type: 'command', powershell: command, timeoutSec: 1200, bash: command },
          ],
        },
      }),
    )
  })

  it('leaves Copilot hooks that only mention it alone, adding its own next to them', async () => {
    const agentStop = MENTIONS.map((mention) => ({
      type: 'command',
      bash: mention,
      powershell: mention,
    }))
    const project = singleRepo({ '.github/hooks/uncheck.json': { hooks: { agentStop } } })
    const command = hookCommand('')

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'copilot'])

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      installOutput(['GitHub Copilot .github/hooks/uncheck.json updated'], command),
    )
    expect(project.read('.github/hooks/uncheck.json')).toBe(
      asWritten({
        hooks: {
          agentStop: [
            ...agentStop,
            { type: 'command', bash: command, powershell: command, timeoutSec: TIMEOUT },
          ],
        },
        version: 1,
      }),
    )
  })
})
