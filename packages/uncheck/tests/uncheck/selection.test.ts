import { cliError, LAYOUTS, project as bareProject, report, singleRepo } from '../utils/project'
import { layoutChecks, NOT_COVERED, SKIPPED_BESIDE_TSC, UNFORMATTED_CODE } from './utils'

describe.each(LAYOUTS)('uncheck check selection in a $name', ({ create, app, tsc }) => {
  const { sherif, checks } = layoutChecks(app)

  it('runs only the checks named with --only', async () => {
    const project = create({ [`${app}src/ugly.ts`]: UNFORMATTED_CODE })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', '--only=tsc'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
      '✔ oxlint passed',
      '○ oxfmt skipped, not selected by --only',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, tsc)',
    ])
    expect(exitCode).toBe(0)
  })

  it('skips the checks named with --skip', async () => {
    const project = create({ [`${app}src/ugly.ts`]: UNFORMATTED_CODE })

    const { exitCode, stdout } = await project.uncheck(['--skip=oxfmt', '--skip=tsc'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
      '✔ oxlint passed',
      '○ oxfmt skipped, disabled with --skip=oxfmt',
      '○ tsc skipped, disabled with --skip=tsc',
      `✔ all checks passed (${checks.filter((name) => name !== 'oxfmt' && name !== 'tsc').join(', ')})`,
    ])
    expect(exitCode).toBe(0)
  })

  it('skips a check whose tool is not installed, unless it is required', async () => {
    const project = create({}, { tools: ['sherif', 'oxlint', 'typescript'] })

    const skipped = await project.uncheck(['--only=oxlint', '--only=oxfmt'])

    expect(report(skipped.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
      '✔ oxlint passed',
      '○ oxfmt skipped, not installed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint)',
    ])
    expect(skipped.exitCode).toBe(0)

    const required = await project.uncheck(['--only=oxlint', '--only=oxfmt', '--require=oxfmt'])

    expect(report(required.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
      '✔ oxlint passed',
      '✘ oxfmt not installed',
      '○ tsc skipped, not selected by --only',
      '✘ 1 of 2 checks failed: oxfmt',
    ])
    expect(required.exitCode).toBe(1)
  })

  it('runs a required check that can run as usual', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck([
      '--only=oxlint',
      '--only=oxfmt',
      '--require=oxlint',
    ])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint, oxfmt)',
    ])
    expect(exitCode).toBe(0)
  })

  it('fails when every check is skipped', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck([
      '--skip=sherif',
      '--skip=oxlint',
      '--skip=oxfmt',
      '--skip=tsc',
    ])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, disabled with --skip=sherif',
      '○ oxlint skipped, disabled with --skip=oxlint',
      '○ oxfmt skipped, disabled with --skip=oxfmt',
      '○ tsc skipped, disabled with --skip=tsc',
      '✘ nothing to check: sherif disabled with --skip=sherif, oxlint disabled with --skip=oxlint, oxfmt disabled with --skip=oxfmt, tsc disabled with --skip=tsc',
    ])
    expect(exitCode).toBe(1)
  })

  it('fails when no check has anything to do with the given files', async () => {
    const project = create({ [`${app}README.md`]: '# App\n' })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc', `${app}README.md`])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      NOT_COVERED,
      '✘ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files',
    ])
    expect(exitCode).toBe(1)
  })

  it('passes when no check has anything to do with the given files and unmatched patterns are allowed', async () => {
    const project = create({ [`${app}README.md`]: '# App\n' })

    const { exitCode, stdout } = await project.uncheck([
      '--no-error-on-unmatched-pattern',
      '--only=tsc',
      `${app}README.md`,
    ])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...SKIPPED_BESIDE_TSC,
      NOT_COVERED,
      '○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files',
    ])
    expect(exitCode).toBe(0)
  })
})

describe('uncheck check selection', () => {
  it('fails in a project that uses none of the tools', async () => {
    const project = bareProject({ 'package.json': { name: 'bare', private: true } }, { tools: [] })

    const { exitCode, stdout } = await project.uncheck()

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not installed',
      '○ oxlint skipped, not installed',
      '○ oxfmt skipped, not installed',
      '○ tsc skipped, no tsconfig.json found',
      '✘ nothing to check: sherif not installed, oxlint not installed, oxfmt not installed, tsc no tsconfig.json found',
    ])
    expect(exitCode).toBe(1)
  })

  it.each([
    {
      contradiction: 'a required check it skips',
      flags: ['--require=tsc', '--skip=tsc'],
      message: '--require=tsc and --skip=tsc contradict each other.',
    },
    {
      contradiction: 'a selected check it skips',
      flags: ['--only=oxlint', '--skip=oxlint'],
      message: '--only=oxlint and --skip=oxlint contradict each other.',
    },
    {
      contradiction: 'a required check it does not select',
      flags: ['--only=oxlint', '--only=oxfmt', '--require=tsc'],
      message: '--require=tsc and --only=oxlint --only=oxfmt contradict each other.',
    },
  ])('refuses $contradiction', async ({ flags, message }) => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await project.uncheck(flags)

    expect(stdout).toBe('')
    expect(stderr).toBe(cliError(message))
    expect(exitCode).toBe(1)
  })

  it('refuses a check name it does not know', async () => {
    const project = singleRepo()

    const { exitCode, stdout, stderr } = await project.uncheck(['--only=eslint'])

    expect(stdout).toContain('USAGE')
    expect(stderr).toBe(
      cliError(
        'Invalid value for flag --only: "eslint". Expected: "sherif" | "oxlint" | "oxfmt" | "tsc"',
      ),
    )
    expect(exitCode).toBe(1)
  })
})
