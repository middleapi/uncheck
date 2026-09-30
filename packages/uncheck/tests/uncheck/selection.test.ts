import { createProject, eachLayout } from '../_shared/project'

eachLayout('uncheck check selection in a $layout repository', ({ layout }) => {
  it('skips a check with --skip and requires it with --require', async () => {
    const project = createProject(layout, { tools: ['oxlint', 'typescript'] })
    const cwd = project.appDir

    project.write({ [project.inApp('src/wrong.ts')]: 'export const wrong: string = 1\n' })

    const skipped = await project.run(['--skip=tsc'], { cwd })

    expect(skipped.code).toBe(0)
    expect(skipped.stdout).toContain('○ oxfmt skipped, not installed\n')
    expect(skipped.stdout).toContain('○ tsc skipped, disabled with --skip=tsc\n')
    expect(skipped.stdout).toContain('✔ all checks passed (oxlint)')

    const required = await project.run(['--require=oxfmt', '--skip=tsc'], { cwd })

    expect(required.code).toBe(1)
    expect(required.stdout).toContain('✘ oxfmt not installed\n')
    expect(required.stdout).toContain('✘ 1 of 2 checks failed: oxfmt\n')
    expect(required.stdout).not.toContain('rerun with')

    const contradiction = await project.run(['--require=tsc', '--skip=tsc'], { cwd })

    expect(contradiction.code).toBe(1)
    expect(contradiction.stdout).toBe('')
    expect(contradiction.stderr).toContain('--require=tsc and --skip=tsc contradict each other.')

    const none = await project.run(['--skip=oxlint', '--skip=oxfmt', '--skip=tsc'], { cwd })

    expect(none.code).toBe(1)
    expect(none.stdout).toContain(
      '✘ nothing to check: sherif not installed, oxlint disabled with --skip=oxlint, oxfmt disabled with --skip=oxfmt, tsc disabled with --skip=tsc\n',
    )
  })

  it('runs only the checks named with --only', async () => {
    const project = createProject(layout)

    project.write({ [project.inApp('src/ugly.ts')]: 'export const   ugly = 1\n' })

    const lint = await project.run(['--only=oxlint'])

    expect(lint.code).toBe(0)
    expect(lint.stdout).toMatch(
      new RegExp(
        [
          `^uncheck in ${project.root}`,
          '○ sherif skipped, not selected by --only',
          // What oxlint prints depends on where it runs: a terminal, CI or an agent.
          '▶ oxlint(?:\\n.*)*?',
          '✔ oxlint passed \\d+ms',
          '○ oxfmt skipped, not selected by --only',
          '○ tsc skipped, not selected by --only',
          '',
          '✔ all checks passed \\(oxlint\\)\\n$',
        ].join('\\n'),
      ),
    )

    const format = await project.run(['--only=oxfmt', '--only=tsc'])

    expect(format.code).toBe(1)
    expect(format.stdout).toContain('✘ oxfmt failed')
    expect(format.stdout).toContain('✔ tsc passed')
    expect(format.stdout).toContain(
      '✘ 1 of 2 checks failed: oxfmt\n  rerun with `--fix` to apply oxfmt fixes\n',
    )

    const skipped = await project.run(['--only=oxlint', '--skip=oxlint'])

    expect(skipped.code).toBe(1)
    expect(skipped.stderr).toContain('--only=oxlint and --skip=oxlint contradict each other.')

    const required = await project.run(['--only=oxlint', '--only=oxfmt', '--require=tsc'])

    expect(required.code).toBe(1)
    expect(required.stderr).toContain(
      '--require=tsc and --only=oxlint --only=oxfmt contradict each other.',
    )

    // A required check among the selected ones is fine.
    const both = await project.run(['--only=oxlint', '--require=oxlint'])

    expect(both.code).toBe(0)
  })

  it('passes a run with given paths none of the selected checks covers, when told to', async () => {
    const project = createProject(layout)

    project.write({ [project.inApp('README.md')]: '# App\n' })

    const lenient = await project.run(
      ['--no-error-on-unmatched-pattern', '--only=tsc', 'README.md', 'missing.md'],
      { cwd: project.appDir },
    )

    expect(lenient.code).toBe(0)
    expect(lenient.stdout).toContain(
      '\n○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files\n',
    )

    const strict = await project.run(['--only=tsc', 'README.md'], { cwd: project.appDir })

    expect(strict.code).toBe(1)
    expect(strict.stdout).toContain('\n✘ nothing to check: ')

    const required = await project.run(['--require=tsc', 'README.md'], { cwd: project.appDir })

    expect(required.code).toBe(1)
    expect(required.stdout).toContain('✘ tsc no tsconfig.json covers the given files\n')
    expect(required.stdout).toContain('✘ 1 of 3 checks failed: tsc\n')
  })
})
