import { dirname } from 'node:path'

import { LAYOUTS, monorepo, singleRepo } from '../utils/project'
import { chmod, COMMAND, HEADER, hookLine, mode, prepare, shownHook, written } from './utils'

describe('prepare flags', () => {
  it('describes itself and the hook its flags write', async () => {
    const { exitCode, stdout, stderr } = await singleRepo().uncheck(['prepare', '--help'])

    expect(stdout).toContain(
      [
        'DESCRIPTION',
        '  Set up git hooks, for the `prepare` script in package.json (`postinstall` with Yarn 2+) so every clone gets them: --pre-commit writes the hook that runs `uncheck staged --fix`',
        '',
        'USAGE',
        '  uncheck prepare [flags]',
        '',
      ].join('\n'),
    )
    expect(stdout).toContain(
      [
        '  --pre-commit        Write the git pre-commit hook, which runs `uncheck staged` on the files of every commit',
        '  --fix               Have the hook apply and stage fixes as well as report. On by default, --no-fix only checks',
        '  --allow-empty       Have the hook let a commit through when the fixes undo every staged change, which makes it empty',
      ].join('\n'),
    )

    for (const flag of ['--cwd', '--only', '--require', '--skip']) {
      expect(stdout).toMatch(new RegExp(`^ {2}${flag} `, 'm'))
    }

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('refuses a directory that does not exist', async () => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await prepare(project, ['--cwd=missing'])

    expect(stdout).toContain('USAGE\n  uncheck prepare [flags]\n')
    expect(stderr).toBe(
      `\nERROR\n  Invalid value for flag --cwd: "missing". Expected: Path does not exist: ${project.path('missing')}\n`,
    )
    expect(exitCode).toBe(1)
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })

  it('asks for --pre-commit, the only thing it prepares', async () => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await project.uncheck(['prepare'])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      '\nERROR\n  Nothing to prepare. Pass --pre-commit to write the git hook that runs `uncheck staged --fix` before every commit.\n',
    )
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })

  it('refuses a check selection that contradicts itself before writing anything', async () => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await prepare(project, ['--only=oxlint', '--skip=oxlint'])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe('\nERROR\n  --only=oxlint and --skip=oxlint contradict each other.\n')
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })
})

describe.each(LAYOUTS)('prepare outside a working tree in a $name', ({ create, app }) => {
  it('has nothing to prepare without a git repository', async () => {
    const project = create({}, { git: 'none' })

    // Without a ceiling, git would find a repository around the temporary folder and hook it.
    const { exitCode, stdout, stderr } = await prepare(project, [], {
      cwd: app,
      env: { GIT_CEILING_DIRECTORIES: dirname(project.dir) },
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('○ no git repository found, nothing to prepare\n')
  })

  it('has nothing to prepare inside the .git folder', async () => {
    const project = create()

    const { exitCode, stdout } = await prepare(project, ['--cwd=.git/hooks'])

    expect(exitCode).toBe(0)
    expect(stdout).toBe('○ no git repository found, nothing to prepare\n')
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })

  it('has nothing to prepare in a bare repository', async () => {
    const project = create()
    project.git('clone', '--bare', '--quiet', '.', 'mirror.git')

    const { exitCode, stdout } = await prepare(project, [], { cwd: 'mirror.git' })

    expect(exitCode).toBe(0)
    expect(stdout).toBe('○ no git repository found, nothing to prepare\n')
    expect(project.exists('mirror.git/hooks/pre-commit')).toBe(false)
  })
})

describe.each(LAYOUTS)('prepare in a $name', ({ create, app }) => {
  it('creates an executable pre-commit hook that runs uncheck staged', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await prepare(project, [], { cwd: app })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app), 'created'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(mode(project, '.git/hooks/pre-commit')).toBe(0o755)
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('creates the hooks folder when git has none', async () => {
    const project = create()
    project.write({ '.git/hooks': null })

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app), 'created'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
  })

  it('leaves an up to date hook unchanged and makes it executable again', async () => {
    const project = create()
    await prepare(project, [], { cwd: app })
    chmod(project, '.git/hooks/pre-commit', 0o644)

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app), 'unchanged'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(mode(project, '.git/hooks/pre-commit')).toBe(0o755)
  })

  it.each([
    [['--no-fix'], 'pnpm exec uncheck staged'],
    [['--allow-empty'], 'pnpm exec uncheck staged --fix --allow-empty'],
    [
      ['--only=oxlint', '--only=oxfmt'],
      'pnpm exec uncheck staged --fix --only=oxlint --only=oxfmt',
    ],
    [
      ['--no-fix', '--require=tsc', '--skip=sherif'],
      'pnpm exec uncheck staged --require=tsc --skip=sherif',
    ],
  ])('updates the hook command for %j', async (flags, command) => {
    const project = create()
    await prepare(project, [], { cwd: app })

    const { exitCode, stdout } = await prepare(project, flags, { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app), 'updated', command))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app, command)}\n`)
    expect(mode(project, '.git/hooks/pre-commit')).toBe(0o755)
  })

  it('takes the directory from --cwd', async () => {
    const project = create()

    const { exitCode, stdout } = await prepare(project, [`--cwd=${project.path(app)}`], {
      cwd: '.git',
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app), 'created'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
  })
})

describe('prepare in several packages of a monorepo', () => {
  const root = hookLine('')
  const core = hookLine('packages/core/', `${COMMAND} --only=oxlint`)
  const app = hookLine('packages/app/')

  it('keeps a line for each package, in the order they were prepared', async () => {
    const project = monorepo()

    await prepare(project)
    await prepare(project, ['--only=oxlint'], { cwd: 'packages/core' })
    const { stdout } = await prepare(project, [], { cwd: 'packages/app' })

    expect(stdout).toBe(written(project.path('.git/hooks/pre-commit'), 'updated'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${root}\n${core}\n${app}\n`)
  })

  it('updates the line of one package in place and leaves the others alone', async () => {
    const project = monorepo()
    await prepare(project)
    await prepare(project, ['--only=oxlint'], { cwd: 'packages/core' })
    await prepare(project, [], { cwd: 'packages/app' })

    const { stdout } = await prepare(project, ['--no-fix'])

    expect(stdout).toBe(written('.git/hooks/pre-commit', 'updated', 'pnpm exec uncheck staged'))
    expect(project.read('.git/hooks/pre-commit')).toBe(
      `${HEADER}${hookLine('', 'pnpm exec uncheck staged')}\n${core}\n${app}\n`,
    )
  })
})
