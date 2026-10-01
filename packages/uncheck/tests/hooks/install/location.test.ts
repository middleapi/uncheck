import {
  CLI,
  LAYOUTS,
  PERMISSIONS_ENFORCED,
  cliError,
  monorepo,
  run,
  temporaryDirectory,
} from '../../utils/project'
import { asWritten, claudeSettings, copilotHooks, hookCommand, installOutput } from './utils'

describe.each(LAYOUTS)('hooks install finds the package in a $name', ({ create, app }) => {
  it('names a folder below the top of the repository in the hook command', async () => {
    const folder = `${app}tools/@scope_v=1.2+x-y`
    const project = create({ [`${folder}/index.ts`]: 'export const tool = 1;\n' })
    const command = hookCommand(`${folder}/`)

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(installOutput(['Claude Code .claude/settings.json created'], command))
    expect(project.read(`${folder}/.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
  })

  it.each(['my tools', "it's", 'café'])(
    'refuses a folder named %j that the hook command cannot name',
    async (name) => {
      const folder = `${app}${name}`
      const project = create({ [`${folder}/index.ts`]: 'export const tool = 1;\n' })

      const { exitCode, stdout, stderr } = await project.uncheck(['hooks', 'install', 'claude'], {
        cwd: folder,
      })

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toBe(
        cliError(
          `The hook command cannot name ${folder}: install from the top of the repository or from a directory whose path has only letters, digits and _=./@+-`,
        ),
      )
      expect(project.exists(`${folder}/.claude`)).toBe(false)
    },
  )

  it('writes a hook for the directory it runs in outside git', async () => {
    const project = create({}, { git: 'none' })
    const command = hookCommand('')

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude', 'copilot'], {
      cwd: app,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      installOutput(
        [
          'Claude Code .claude/settings.json created',
          'GitHub Copilot .github/hooks/uncheck.json created',
        ],
        command,
      ),
    )
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
    expect(project.read(`${app}.github/hooks/uncheck.json`)).toBe(asWritten(copilotHooks(command)))
  })

  it('installs into the directory given with --cwd, wherever it runs', async () => {
    const project = create()
    const command = hookCommand(app)

    const { exitCode, stdout } = await run(
      [...CLI, 'hooks', 'install', 'claude', `--cwd=${project.path(app)}`],
      { cwd: temporaryDirectory() },
    )

    expect(exitCode).toBe(0)
    expect(stdout).toBe(installOutput(['Claude Code .claude/settings.json created'], command))
    expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
  })

  it('reports a config it cannot read', async () => {
    const project = create({ [`${app}.claude`]: 'not a folder\n' })

    const { exitCode, stdout, stderr } = await project.uncheck(['hooks', 'install', 'claude'], {
      cwd: app,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError(`BadResource: FileSystem.readFile (${project.path(`${app}.claude/settings.json`)})`),
    )
  })

  it.runIf(PERMISSIONS_ENFORCED)(
    'reports a config it cannot write, after writing the ones before it',
    async () => {
      const project = create({ [`${app}.cursor/rules.md`]: '# Rules\n' }).chmod(
        `${app}.cursor`,
        0o555,
      )
      const command = hookCommand(app)

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['hooks', 'install', 'cursor', 'claude'],
        { cwd: app },
      )

      expect(exitCode).toBe(1)
      expect(stdout).toBe('✔ Claude Code .claude/settings.json created\n')
      expect(stderr).toBe(
        cliError(
          `PermissionDenied: FileSystem.writeFile (${project.path(`${app}.cursor/hooks.json`)})`,
        ),
      )
      expect(project.read(`${app}.claude/settings.json`)).toBe(asWritten(claudeSettings(command)))
      expect(project.exists(`${app}.cursor/hooks.json`)).toBe(false)
    },
  )

  it.runIf(PERMISSIONS_ENFORCED)('reports a folder it cannot look into', async () => {
    const project = create({ [`${app}locked/notes.md`]: '# Notes\n' }).chmod(`${app}locked`, 0o644)

    const { exitCode, stdout, stderr } = await project.uncheck([
      'hooks',
      'install',
      'claude',
      `--cwd=${project.path(`${app}locked`)}`,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError(
        `PermissionDenied: FileSystem.readFile (${project.path(`${app}locked/.claude/settings.json`)})`,
      ),
    )
  })
})

describe('hooks install in a monorepo package', () => {
  it('refuses Copilot, which reads its hooks only at the top of the repository', async () => {
    const project = monorepo()

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['hooks', 'install', 'claude', 'copilot'],
      { cwd: 'packages/app' },
    )

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError(
        'Copilot reads .github/hooks only at the top of the repository, not in packages/app: install copilot from there',
      ),
    )
    expect(project.exists('packages/app/.claude')).toBe(false)
    expect(project.exists('packages/app/.github')).toBe(false)
  })
})
