import {
  CLI,
  LAYOUTS,
  cliError,
  monorepo,
  report,
  run,
  singleRepo,
  temporaryDirectory,
} from '../../utils/project'
import { CLAUDE_CODE_STOP, stopHook } from './utils'

const UNFORMATTED = 'export const   extra = 1\n'
const FORMATTED = 'export const extra = 1;\n'

const ONLY_OXFMT = [
  '○ sherif skipped, not selected by --only',
  '○ oxlint skipped, not selected by --only',
]

describe.each(LAYOUTS)('hooks run finds the project in a $name', ({ create, app }) => {
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

  it('reports a --dir that names nothing instead of sending the agent back', async () => {
    const project = create().write({ [`${app}src/extra.ts`]: UNFORMATTED })

    const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP, {
      args: ['--fix', `--dir=${app}gone`],
      cwd: `${app}src`,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      cliError(
        `--dir=${app}gone names nothing in ${project.dir}, run \`uncheck hooks install\` again from the project`,
      ),
    )
    expect(project.read(`${app}src/extra.ts`)).toBe(UNFORMATTED)
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
