import {
  CLI,
  LAYOUTS,
  cliError,
  git,
  linkedWorktree,
  monorepo,
  report,
  run,
  singleRepo,
  temporaryDirectory,
} from '../../utils/project'
import { CLAUDE_CODE_STOP, TYPE_ERROR, dirFlags, hookEnv, stopHook } from './utils'

const UNFORMATTED = 'export const   extra = 1\n'
const FORMATTED = 'export const extra = 1;\n'

const ONLY_OXFMT = [
  '○ sherif skipped, not selected by --only',
  '○ oxlint skipped, not selected by --only',
]

function oxfmtFailed(dir: string): string[] {
  return [
    `uncheck in ${dir}`,
    ...ONLY_OXFMT,
    '▶ oxfmt --check --no-error-on-unmatched-pattern src/extra.ts',
    '✘ oxfmt failed',
    '○ tsc skipped, not selected by --only',
    '✘ 1 of 1 checks failed: oxfmt',
    '  rerun with `--fix` to apply oxfmt fixes',
  ]
}

describe.each(LAYOUTS)('hooks run finds the project in a $name', ({ create, app, tsc }) => {
  it('checks the directory given with --cwd, wherever it runs', async () => {
    const project = create().write({ [`${app}src/extra.ts`]: UNFORMATTED })

    const { exitCode, stdout, stderr } = await run(
      [...CLI, 'hooks', 'run', '--fix', '--only=oxfmt', `--cwd=${project.path(app)}`],
      { cwd: temporaryDirectory(), input: JSON.stringify(CLAUDE_CODE_STOP) },
    )

    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual([
      `uncheck in ${project.path(app, '.')}`,
      ...ONLY_OXFMT,
      '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxfmt)',
    ])
    expect(project.read(`${app}src/extra.ts`)).toBe(FORMATTED)
  })

  it.each(['gone', 'package.json'])(
    'reports a --dir naming %s, which is no folder, instead of sending the agent back',
    async (name) => {
      const project = create().write({ [`${app}src/extra.ts`]: UNFORMATTED })

      const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP, {
        args: ['--fix', `--dir=${app}${name}`],
        cwd: `${app}src`,
      })

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toBe(
        cliError(
          `--dir=${app}${name} names no folder in ${project.dir}, run \`uncheck hooks install\` again from the project`,
        ),
      )
      expect(project.read(`${app}src/extra.ts`)).toBe(UNFORMATTED)
    },
  )

  it.each(['CLAUDE_PROJECT_DIR', 'CODEBUDDY_PROJECT_DIR'])(
    'checks the project in %s outside git, from the folder the agent moved to',
    async (variable) => {
      const project = create({ [`${app}src/index.ts`]: TYPE_ERROR }, { git: 'none' })

      const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP, {
        args: ['--fix', '--only=tsc'],
        cwd: `${app}src`,
        env: { [variable]: project.path(app) },
      })

      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '○ oxfmt skipped, not selected by --only',
        tsc,
        '✘ tsc failed',
        '✘ 1 of 1 checks failed: tsc',
      ])
    },
  )

  it("checks the agent's project from a folder outside git", async () => {
    const project = create().write({ [`${app}src/extra.ts`]: UNFORMATTED })

    const { exitCode, stdout, stderr } = await run(
      [...CLI, 'hooks', 'run', '--only=oxfmt', ...dirFlags(app)],
      {
        cwd: temporaryDirectory(),
        env: hookEnv({ CLAUDE_PROJECT_DIR: project.path(app) }),
        input: JSON.stringify(CLAUDE_CODE_STOP),
      },
    )

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual(oxfmtFailed(project.path(app, '.')))
  })

  it("checks the agent's project from a submodule the agent moved into", async () => {
    const library = temporaryDirectory()

    git(library, ['init', '--quiet'])
    git(library, ['commit', '--quiet', '--allow-empty', '--message=library'])

    const project = create()

    project.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      library,
      'vendor/lib',
    )
    project.commit('submodule').write({ [`${app}src/extra.ts`]: UNFORMATTED })

    const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
      args: ['--only=oxfmt'],
      cwd: 'vendor/lib',
      env: { CLAUDE_PROJECT_DIR: project.path(app) },
    })

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual(oxfmtFailed(project.path(app, '.')))
  })

  it('checks the linked worktree the agent works in, although its project folder is the main checkout', async () => {
    const project = create()
    const worktree = linkedWorktree(project, app).write({ [`${app}src/extra.ts`]: UNFORMATTED })

    const { exitCode, stdout, stderr } = await stopHook(worktree, app, CLAUDE_CODE_STOP, {
      args: ['--only=oxfmt'],
      cwd: `${app}src`,
      env: { CLAUDE_PROJECT_DIR: project.path(app) },
    })

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual(oxfmtFailed(worktree.path(app, '.')))
  })

  it('checks the repository the agent moved to when it is not part of the project', async () => {
    const elsewhere = temporaryDirectory()

    git(elsewhere, ['init', '--quiet'])

    const project = create().write({ [`${app}src/extra.ts`]: UNFORMATTED })

    const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
      args: ['--only=oxfmt'],
      cwd: `${app}src`,
      env: { CLAUDE_PROJECT_DIR: elsewhere },
    })

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual(oxfmtFailed(project.path(app, '.')))
  })
})

describe('hooks run in a monorepo', () => {
  it('checks only the package in --dir from wherever the agent moved to, and the whole repository without it', async () => {
    const project = monorepo().write({
      'packages/app/src/extra.ts': UNFORMATTED,
      'packages/core/src/extra.ts': UNFORMATTED,
    })

    const app = await stopHook(project, 'packages/app/', CLAUDE_CODE_STOP, {
      args: ['--only=oxfmt'],
      cwd: 'packages/core/src',
    })

    expect(app.exitCode).toBe(2)
    expect(app.stdout).toBe('')
    expect(report(app.stderr)).toEqual([
      `uncheck in ${project.path('packages/app')}`,
      ...ONLY_OXFMT,
      '▶ oxfmt --check --no-error-on-unmatched-pattern src/extra.ts',
      '✘ oxfmt failed',
      '○ tsc skipped, not selected by --only',
      '✘ 1 of 1 checks failed: oxfmt',
      '  rerun with `--fix` to apply oxfmt fixes',
    ])

    const top = await stopHook(project, '', CLAUDE_CODE_STOP, {
      args: ['--fix', '--only=oxfmt'],
      cwd: 'packages/core/src',
    })

    expect(top.exitCode).toBe(0)
    expect(top.stdout).toBe('')
    expect(report(top.stderr)).toEqual([
      `uncheck in ${project.dir}`,
      ...ONLY_OXFMT,
      '▶ oxfmt --no-error-on-unmatched-pattern packages/app/src/extra.ts packages/core/src/extra.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxfmt)',
    ])
    expect(project.read('packages/app/src/extra.ts')).toBe(FORMATTED)
    expect(project.read('packages/core/src/extra.ts')).toBe(FORMATTED)
  })

  it('takes --dir from the top of the repository around --cwd, not around where it runs', async () => {
    const project = monorepo().write({
      'packages/app/src/extra.ts': UNFORMATTED,
      'packages/core/src/extra.ts': UNFORMATTED,
    })

    const { exitCode, stdout, stderr } = await run(
      [
        ...CLI,
        'hooks',
        'run',
        '--fix',
        '--only=oxfmt',
        `--cwd=${project.path('packages/core/src')}`,
        '--dir=packages/app',
      ],
      { cwd: temporaryDirectory(), input: JSON.stringify(CLAUDE_CODE_STOP) },
    )

    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual([
      `uncheck in ${project.path('packages/app')}`,
      ...ONLY_OXFMT,
      '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxfmt)',
    ])
    expect(project.read('packages/app/src/extra.ts')).toBe(FORMATTED)
    expect(project.read('packages/core/src/extra.ts')).toBe(UNFORMATTED)
  })
})

describe('hooks run arguments', () => {
  it('refuses a --cwd that does not exist, checking nothing', async () => {
    const project = singleRepo().write({ 'src/extra.ts': UNFORMATTED })
    const gone = project.path('gone')

    const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP, {
      args: ['--fix', `--cwd=${gone}`],
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('USAGE\n  uncheck hooks run [flags]\n')
    expect(stderr).toBe(
      cliError(`Invalid value for flag --cwd: "${gone}". Expected: Path does not exist: ${gone}`),
    )
    expect(project.read('src/extra.ts')).toBe(UNFORMATTED)
  })
})
