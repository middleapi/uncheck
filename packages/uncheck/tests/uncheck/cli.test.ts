import { readFileSync } from 'node:fs'

import {
  CLI,
  cliError,
  LAYOUTS,
  report,
  run,
  singleRepo,
  temporaryDirectory,
} from '../utils/project'
import { CODE_WITH_VAR } from './utils'

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }

function onlyOxlint(dir: string): string[] {
  return [
    `uncheck in ${dir}`,
    '○ sherif skipped, not selected by --only',
    '▶ oxlint',
    '✔ oxlint passed',
    '○ oxfmt skipped, not selected by --only',
    '○ tsc skipped, not selected by --only',
    '✔ all checks passed (oxlint)',
  ]
}

describe.each(LAYOUTS)('uncheck --cwd in a $name', ({ create, app }) => {
  const legacyOutsideSrc = { [`${app}legacy.ts`]: CODE_WITH_VAR }

  it('checks the directory given relative to the current one', async () => {
    const project = create(legacyOutsideSrc)

    const { exitCode, stdout } = await project.uncheck(['--cwd', `${app}src`, '--only=oxlint'])

    expect(report(stdout)).toEqual(onlyOxlint(project.path(app, 'src')))
    expect(exitCode).toBe(0)
  })

  it('checks the directory given as an absolute path', async () => {
    const project = create(legacyOutsideSrc)

    const { exitCode, stdout } = await run(
      [...CLI, `--cwd=${project.path(app, 'src')}`, '--only=oxlint'],
      { cwd: temporaryDirectory() },
    )

    expect(report(stdout)).toEqual(onlyOxlint(project.path(app, 'src')))
    expect(exitCode).toBe(0)
  })

  it.each([
    { given: 'a directory that does not exist', cwd: 'missing', problem: 'Path does not exist' },
    { given: 'a file', cwd: 'src/index.ts', problem: 'Path is not a directory' },
  ])('refuses $given', async ({ cwd, problem }) => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck(['--cwd', `${app}${cwd}`])

    expect(stdout).toContain('USAGE')
    expect(stderr).toBe(
      cliError(
        `Invalid value for flag --cwd: "${app}${cwd}". Expected: ${problem}: ${project.path(app, cwd)}`,
      ),
    )
    expect(exitCode).toBe(1)
  })
})

describe('uncheck command line', () => {
  it('prints its version', async () => {
    const { exitCode, stdout, stderr } = await singleRepo().uncheck(['--version'])

    expect(stdout).toBe(`uncheck v${version}\n`)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('prints its usage', async () => {
    const { exitCode, stdout, stderr } = await singleRepo().uncheck(['--help'])

    expect(stdout).toContain('USAGE\n  uncheck <subcommand> [flags] [<paths...>]\n')

    for (const flag of [
      '--cwd',
      '--fix',
      '--no-error-on-unmatched-pattern',
      '--only',
      '--require',
      '--skip',
    ]) {
      expect(stdout).toMatch(new RegExp(`^ {2}${flag} `, 'm'))
    }

    for (const subcommand of ['staged', 'prepare', 'hooks']) {
      expect(stdout).toMatch(new RegExp(`^ {2}${subcommand} `, 'm'))
    }

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it('prints a shell completion script', async () => {
    const { exitCode, stdout, stderr } = await singleRepo().uncheck(['--completions', 'bash'])

    expect(stdout).toMatch(/^###-begin-uncheck-completions-###\n/)
    expect(stdout).toContain("compgen -W 'staged prepare hooks'")
    expect(stdout).toMatch(/\ncomplete -F _uncheck uncheck\n###-end-uncheck-completions-###\n$/)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  it.each(['--wizard', '--log-level'])('refuses the global flag %s it leaves out', async (flag) => {
    const { exitCode, stdout, stderr } = await singleRepo().uncheck([flag])

    expect(stdout).toContain('USAGE')
    expect(stderr).toBe(cliError(`Unrecognized flag: ${flag} in command uncheck`))
    expect(exitCode).toBe(1)
  })
})
