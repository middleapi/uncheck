import { claudeSettings, cursorHooks, hookCommand } from '../hooks/install/utils'
import { HEADER, hookLine } from '../prepare/utils'
import { cliError, monorepo, singleRepo } from '../utils/project'
import { SCRIPTS, bareProject, fakePackageManagers, initOutput, manifestOf } from './utils'

describe('init --yes in a project without the tools', () => {
  it('installs uncheck, oxlint and oxfmt, adds the scripts and writes the pre-commit hook', async () => {
    const project = bareProject()
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout, stderr } = await project.uncheck(['init', '--yes'], { env })

    expect(stderr).toBe('')
    expect(project.normalize(stdout)).toBe(
      `uncheck init in <project>\n${initOutput([
        '▶ pnpm add --save-dev uncheck oxlint oxfmt',
        'pnpm added uncheck oxlint oxfmt',
        '✔ package.json scripts check, fix and prepare written',
        '✔ pre-commit .git/hooks/pre-commit created',
      ])}`,
    )
    expect(exitCode).toBe(0)
    expect(calls()).toEqual(['pnpm add --save-dev uncheck oxlint oxfmt'])
    expect(manifestOf(project)).toEqual({
      name: 'app',
      version: '1.0.0',
      private: true,
      type: 'module',
      devDependencies: { uncheck: '^1.0.0', oxlint: '^1.0.0', oxfmt: '^1.0.0' },
      scripts: SCRIPTS,
    })
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine('')}\n`)
  })

  it('writes the hooks of the agents whose folders the project has', async () => {
    const project = bareProject({ '.claude/agents/review.md': '# Review\n', '.cursor/rules': '' })
    const { env } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'], { env })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      '✔ pre-commit .git/hooks/pre-commit created\n✔ Claude Code .claude/settings.json created\n✔ Cursor .cursor/hooks.json created\n',
    )
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual(
      claudeSettings(hookCommand('')),
    )
    expect(JSON.parse(project.read('.cursor/hooks.json'))).toEqual(cursorHooks(hookCommand('')))
    expect(project.exists('.codebuddy')).toBe(false)
  })

  it('leaves the agents that already run uncheck as they are', async () => {
    const fast = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: hookCommand('', ['--only=oxlint']) }],
          },
        ],
      },
    }
    const project = bareProject({ '.claude/settings.json': fast, '.codebuddy/settings.json': {} })
    const { env } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'], { env })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      '○ Claude Code .claude/settings.json already runs uncheck\n✔ CodeBuddy .codebuddy/settings.json updated\n',
    )
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual(fast)
    expect(JSON.parse(project.read('.codebuddy/settings.json'))).toEqual(
      claudeSettings(hookCommand('')),
    )
  })

  it('refuses agents in a folder the hook cannot name before installing anything', async () => {
    const project = bareProject({
      'my tools/package.json': { name: 'tools', private: true },
      'my tools/.claude/settings.json': {},
    })
    const { env, calls } = fakePackageManagers()

    const { exitCode, stderr } = await project.uncheck(['init', '--yes'], {
      cwd: 'my tools',
      env,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toBe(
      cliError(
        'The hook command cannot name my tools: install from the top of the repository or from a directory whose path has only letters, digits and _=./@+-',
      ),
    )
    expect(calls()).toEqual([])
    expect(manifestOf(project).scripts).toBeUndefined()
  })
})

describe('init --yes in a project with the tools installed', () => {
  it('installs nothing and changes nothing when run again', async () => {
    const project = singleRepo()
    const { env, calls } = fakePackageManagers()

    const first = await project.uncheck(['init', '--yes'], { env })

    expect(project.normalize(first.stdout)).toBe(
      `uncheck init in <project>\n${initOutput([
        '✔ package.json scripts check, fix and prepare written',
        '✔ pre-commit .git/hooks/pre-commit created',
      ])}`,
    )
    expect(first.exitCode).toBe(0)

    const manifest = project.read('package.json')
    const second = await project.uncheck(['init', '--yes'], { env })

    expect(project.normalize(second.stdout)).toBe(
      `uncheck init in <project>\n${initOutput([
        '✔ package.json unchanged',
        '○ pre-commit left to the prepare script, which writes it on every install',
      ])}`,
    )
    expect(second.exitCode).toBe(0)
    expect(project.read('package.json')).toBe(manifest)
    expect(calls()).toEqual([])
  })

  it('sets up a package of a monorepo on its own, pointing at the workspace root', async () => {
    const project = monorepo()
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'], {
      cwd: 'packages/app',
      env,
    })

    expect(project.normalize(stdout)).toBe(
      `uncheck init in <project>/packages/app\n○ inside the workspace at ../.., run uncheck init there to set up every package\n${initOutput(
        [
          '✔ package.json scripts check, fix and prepare written',
          '✔ pre-commit <project>/.git/hooks/pre-commit created',
        ],
      )}`,
    )
    expect(exitCode).toBe(0)
    expect(calls()).toEqual([])
    expect(manifestOf(project).scripts).toBeUndefined()
    expect(JSON.parse(project.read('packages/app/package.json'))).toHaveProperty('scripts', SCRIPTS)
    expect(project.read('.git/hooks/pre-commit')).toContain(`${hookLine('packages/app/')}\n`)
  })

  it('writes nothing for the pre-commit hook outside a git repository', async () => {
    const project = singleRepo({}, { git: 'none' })

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'])

    expect(exitCode).toBe(0)
    expect(stdout).toContain('○ no git repository found, nothing to prepare\n')
    expect(manifestOf(project).scripts).toEqual(SCRIPTS)
  })
})

describe('init refuses to start', () => {
  it('without a package.json', async () => {
    const project = bareProject({ 'package.json': null })

    const { exitCode, stdout, stderr } = await project.uncheck(['init', '--yes'])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError(
        `No package.json in ${project.dir} to set up: create one first, for example with \`npm init\``,
      ),
    )
  })

  it.each(['{ "name": "app", }\n', '[]\n'])(
    'with a package.json that is not a JSON object: %j',
    async (manifest) => {
      const project = bareProject({ 'package.json': manifest })

      const { exitCode, stdout, stderr } = await project.uncheck(['init', '--yes'])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toBe(
        cliError(
          `${project.path('package.json')} is not a JSON object, fix it and run uncheck init again`,
        ),
      )
    },
  )

  it('without a terminal to ask in, unless told to take the defaults', async () => {
    const project = bareProject()
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout, stderr } = await project.uncheck(['init'], { env })

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError('Answer the questions in a terminal, or pass --yes to take the default answers'),
    )
    expect(calls()).toEqual([])
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })
})
