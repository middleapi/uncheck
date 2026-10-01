import { cliError, LAYOUTS, report, run } from '../utils/project'
import { commitOnSide, folderOf, inIndex, stagePartially, VERSIONS } from './utils'

describe.each(LAYOUTS)('uncheck staged during a merge in a $name', ({ create, app }) => {
  const folder = folderOf(app)
  const other = `${app}src/other.ts`

  it('checks only the staged files that differ from the branch being merged in', async () => {
    const project = commitOnSide(create({ [other]: 'export const other = 2;\n' }), {
      [`${app}src/theirs.ts`]: 'export const   theirs = 1\n',
      [other]: 'export const other = 3;\n',
    })

    project.git('merge', '--quiet', '--no-commit', '--no-ff', 'side')

    const theirs = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(theirs.exitCode).toBe(0)
    expect(report(theirs.stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ nothing to check, every staged file comes from the branch being merged in',
    ])

    project.stage({ [other]: 'export const   other = 4\n' })

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/other.ts')
    expect(report(stdout).at(-1)).toBe('✔ staged the fixes to src/other.ts')
    expect(inIndex(project, other)).toBe('export const other = 4;\n')
    expect(inIndex(project, `${app}src/theirs.ts`)).toBe('export const   theirs = 1\n')
  })

  it('leaves out what the branch being merged in deletes, even beside a file named MERGE_HEAD', async () => {
    const project = commitOnSide(
      create({
        [`${app}MERGE_HEAD`]: 'not a revision\n',
        [`${app}src/gone.ts`]: 'export const gone = 1;\n',
      }),
      { [`${app}src/gone.ts`]: null },
    )

    project.git('merge', '--quiet', '--no-commit', '--no-ff', 'side')

    const { exitCode, stdout, stderr } = await project.uncheck(['staged'], { cwd: folder })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ nothing to check, every staged file comes from the branch being merged in',
    ])
  })

  it('never takes a merge whose fixes bring back the tree of HEAD for an empty commit', async () => {
    const project = commitOnSide(create({ [other]: 'export const other = 2;\n' }), {
      [other]: 'export const other = 3;\n',
    })

    project.git('merge', '--quiet', '--no-commit', '--no-ff', 'side')
    project.stage({ [other]: 'export const   other = 2\n' })

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt'],
      { cwd: folder },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout).at(-1)).toBe('✔ staged the fixes to src/other.ts')
    expect(project.git('diff', '--cached', '--name-only')).toBe('')

    project.git('commit', '--quiet', '--no-edit', '--no-verify')

    expect(project.git('rev-parse', 'HEAD^2')).toBe(project.git('rev-parse', 'side'))
  })

  it('reports what git refuses while the merge still has conflicts', async () => {
    const file = `${app}src/extra.ts`
    const project = commitOnSide(
      create({ [file]: VERSIONS.committed, [other]: 'export const other = 1;\n' }),
      { [other]: 'export const other = 2;\n' },
    )

    project.write({ [other]: 'export const other = 3;\n' }).commit('main')

    const merge = await run(['git', 'merge', 'side'], { cwd: project.dir })

    expect(merge.exitCode).toBe(1)

    stagePartially(project, file)

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--only=oxfmt'], {
      cwd: folder,
    })

    const unmerged = project
      .git('ls-files', '--unmerged', '--', other)
      .trimEnd()
      .split('\n')
      .map((entry) => `${other}: unmerged (${entry.split(' ')[1]})\n`)
      .join('')

    expect(stderr).toBe(
      cliError(`git write-tree failed: ${unmerged}fatal: git-write-tree: error building trees`),
    )
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
  })
})
