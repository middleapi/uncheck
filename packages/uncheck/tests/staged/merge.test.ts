import { spawnSync } from 'node:child_process'

import { createProject, eachLayout } from '../_shared/project'
import { at, commitOnSide, expectExit, inApp } from './helpers'

eachLayout('$layout', ({ layout }) => {
  it('checks only the files of a merge that differ from the side merged in', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged, index } = at(project, project.appDir)
    const [theirs, ours] = [project.inApp('src/theirs.ts'), project.inApp('src/ours.ts')]

    commitOnSide(project, {
      [theirs]: 'export const   theirs = 1\n',
      [ours]: 'export const ours = 1\n',
    })
    project.git('merge', '--quiet', '--no-commit', '--no-ff', 'side')

    const merged = await staged(['--fix', '--only=oxfmt'])

    expectExit(merged, 0)
    expect(merged.stdout).toContain(
      '○ nothing to check, every staged file comes from the branch being merged in\n',
    )

    project.write({ [ours]: 'export const   ours = 2\n' })
    project.git('add', ours)

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/ours.ts\n')
    expect(index('src/ours.ts')).toBe('export const ours = 2\n')
    expect(index('src/theirs.ts')).toBe('export const   theirs = 1\n')
  })

  it('lets a merge through when the fixes turn its tree back into what HEAD has', async () => {
    const file = inApp(layout, 'src/other.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [file]: 'export const other = 2\n' },
    })
    const { staged } = at(project, project.appDir)

    commitOnSide(project, { [file]: 'export const other = 3\n' })
    project.git('merge', '--quiet', '--no-commit', '--no-ff', 'side')
    project.write({ [file]: 'export const   other = 2\n' })
    project.git('add', file)

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain('✔ staged the fixes to src/other.ts\n')
    expect(project.git('diff', '--cached', '--name-only')).toBe('')
  })

  // The other package of the monorepo, or a folder of the single one, left out of the checkout.
  const away = layout === 'single' ? 'lib/lib.ts' : 'packages/lib/src/index.ts'
  const kept = layout === 'single' ? 'src' : 'packages/app'

  it('undoes or stages only what the fixes changed, so a merge can bring in files outside a sparse checkout', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [away]: 'export const lib = 1\n' },
    })
    const file = project.inApp('src/sparse.ts')

    commitOnSide(project, { [away]: 'export const lib = 2\n' })
    project.git('sparse-checkout', 'set', kept)
    project.git('merge', '--quiet', '--squash', 'side')
    project.write({ [file]: 'export const   sparse = 1\n' })
    project.git('add', file)
    project.write({ [file]: 'export const   sparse = 2\n' })

    const conflict = await project.run(['staged', '--fix', '--only=oxfmt'])

    expectExit(conflict, 1)
    expect(conflict.stderr).toContain(`fixes conflict with the unstaged changes of ${file}`)
    expect(project.git('status', '--porcelain')).toBe(
      layout === 'single' ? `M  ${away}\nAM ${file}\n` : `AM ${file}\nM  ${away}\n`,
    )

    project.git('add', file)

    const result = await project.run(['staged', '--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain(`✔ staged the fixes to ${file}\n`)
    expect(project.exists(away)).toBe(false)
    expect(project.git('show', `:${away}`)).toBe('export const lib = 2\n')
    expect(project.git('show', `:${file}`)).toBe('export const sparse = 2\n')
  })

  it('has nothing to check when every staged file is outside a sparse checkout', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [away]: 'export const lib = 1\n' },
    })

    commitOnSide(project, { [away]: 'export const   lib = 2\n' })
    project.git('sparse-checkout', 'set', kept)
    project.git('merge', '--quiet', '--squash', 'side')

    const result = await project.run(['staged', '--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain(`○ nothing to check, no files match ${away}\n`)
    expect(project.git('show', `:${away}`)).toBe('export const   lib = 2\n')
  })

  it('stages fixes to a conflict a merge left outside a sparse checkout', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [away]: 'export const lib = 1\n' },
    })

    commitOnSide(project, { [away]: 'export const lib = 2\n' })
    project.write({ [away]: 'export const lib = 3\n' })
    project.commit('main')
    project.git('sparse-checkout', 'set', kept)
    // The merge stops on the conflict, which git writes out although the path is outside the checkout.
    spawnSync('git', ['merge', '--quiet', 'side'], { cwd: project.root, env: project.env })
    project.write({ [away]: 'export const   lib = 4\n' })
    project.git('add', '--sparse', away)

    const result = await project.run(['staged', '--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(project.git('show', `:${away}`)).toBe('export const lib = 4\n')
  })
})
