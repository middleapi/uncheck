import { cliError, commitOnSide, LAYOUTS, report, run } from '../utils/project'
import { conflictError, expectFixesStaged, folderOf, inIndex } from './utils'

describe.each(LAYOUTS)('uncheck staged in a sparse checkout of a $name', ({ create, app }) => {
  const folder = folderOf(app)
  const file = `${app}src/extra.ts`
  const outside = `${app}lib/lib.ts`

  it('undoes or stages only what the fixes changed, leaving a staged file outside the cone alone', async () => {
    const project = commitOnSide(
      create({ [file]: 'export const extra = 1;\n', [outside]: 'export const lib = 1;\n' }),
      { [outside]: 'export const lib = 2;\n' },
    )

    project.git('sparse-checkout', 'set', `${app}src`)
    project.git('merge', '--quiet', '--squash', 'side')
    project.stage({ [file]: 'export const   extra = 42\n' })
    project.write({ [file]: 'export const   extra = 43\n' })

    const conflicted = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(conflicted.stderr).toBe(cliError(conflictError('src/extra.ts')))
    expect(conflicted.exitCode).toBe(1)
    expect(project.git('status', '--porcelain')).toBe(`M  ${outside}\nMM ${file}\n`)
    expect(project.read(file)).toBe('export const   extra = 43\n')

    project.git('add', '--', file)

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts')
    expectFixesStaged(stdout, 'src/extra.ts', 'oxfmt')
    expect(project.exists(`${app}lib`)).toBe(false)
    expect(inIndex(project, outside)).toBe('export const lib = 2;\n')
    expect(inIndex(project, file)).toBe('export const extra = 43;\n')
  })

  it('stages the fixes to a conflict a merge left outside the cone', async () => {
    const project = commitOnSide(create({ [outside]: 'export const lib = 1;\n' }), {
      [outside]: 'export const lib = 2;\n',
    })

    project.write({ [outside]: 'export const lib = 3;\n' }).commit('main')
    project.git('sparse-checkout', 'set', `${app}src`)

    const merge = await run(['git', 'merge', '--quiet', 'side'], { cwd: project.dir })

    expect(merge.exitCode).toBe(1)

    project.write({ [outside]: 'export const   lib = 4\n' })
    project.git('add', '--sparse', '--', outside)

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expectFixesStaged(stdout, 'lib/lib.ts', 'oxfmt')
    expect(inIndex(project, outside)).toBe('export const lib = 4;\n')
  })
})
