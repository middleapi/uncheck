import { LAYOUTS, report } from '../utils/project'
import { folderOf, inIndex, VERSIONS } from './utils'

describe.each(LAYOUTS)('uncheck staged with many files in a $name', ({ create, app }) => {
  const folder = folderOf(app)

  it('splits git and tool calls whose paths pass 30,000 characters', async () => {
    const named = (group: string) =>
      Array.from(
        { length: 150 },
        (_, index) => `${app}src/${group}${String(index).padStart(3, '0')}${'x'.repeat(195)}.ts`,
      )
    const fixed = named('f')
    const partial = named('p')
    const withVersion = (files: ReadonlyArray<string>, version: string) =>
      Object.fromEntries(files.map((file) => [file, version]))
    const project = create(withVersion([...fixed, ...partial], VERSIONS.committed))

    project.stage({
      ...withVersion(fixed, VERSIONS.staged),
      ...withVersion(partial, VERSIONS.fixed),
    })
    project.write(withVersion(partial, VERSIONS.merged))

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxlint', '--only=oxfmt'],
      { cwd: folder },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ unstaged changes of [150 files] set aside until the checks finish',
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --fix --no-error-on-unmatched-pattern [143 files]',
      '▶ oxlint --fix --no-error-on-unmatched-pattern [143 files]',
      '▶ oxlint --fix --no-error-on-unmatched-pattern [14 files]',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern [143 files]',
      '▶ oxfmt --no-error-on-unmatched-pattern [143 files]',
      '▶ oxfmt --no-error-on-unmatched-pattern [14 files]',
      '✔ oxfmt passed',
      '○ knip skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '✔ staged the fixes to [150 files]',
      '○ unstaged changes of [150 files] restored',
      '✔ all checks passed (oxlint, oxfmt)',
    ])

    for (const file of [fixed[0]!, fixed.at(-1)!]) {
      expect(inIndex(project, file)).toBe(VERSIONS.fixed)
      expect(project.read(file)).toBe(VERSIONS.fixed)
    }

    for (const file of [partial[0]!, partial.at(-1)!]) {
      expect(inIndex(project, file)).toBe(VERSIONS.fixed)
      expect(project.read(file)).toBe(VERSIONS.merged)
    }
  })
})
