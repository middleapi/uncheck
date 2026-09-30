import { chmodSync } from 'node:fs'

import { LAYOUTS, report, run } from '../utils/project'
import type { Project } from '../utils/project'
import { inIndex, linkedWorktree, stage, stagePartially, status, VERSIONS } from './utils'

describe.each(LAYOUTS)('uncheck staged as the pre-commit hook of a $name', ({ create, app }) => {
  const file = `${app}src/extra.ts`
  const other = `${app}src/other.ts`

  function hooked(): Project {
    const project = create({ [file]: VERSIONS.committed, [other]: 'export const other = 1;\n' })

    project.write({
      '.git/hooks/pre-commit': `#!/bin/sh\n(cd "./${app}" && pnpm exec uncheck staged --fix) || exit 1\n`,
    })
    chmodSync(project.path('.git/hooks/pre-commit'), 0o755)

    return project
  }

  it('fixes the files of `git commit <paths>` in the commit and in the index it leaves', async () => {
    const project = hooked()

    stage(project, { [other]: 'export const other = 2;\n' })
    project.write({ [file]: VERSIONS.staged })

    const { exitCode, stderr } = await run(
      ['git', 'commit', '--quiet', '--message=extra', '--', file],
      { cwd: project.path('.') },
    )

    expect(exitCode).toBe(0)
    expect(report(stderr).at(-1)).toBe('✔ staged the fixes to src/extra.ts')
    expect(project.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
    expect(project.git('show', `HEAD:${other}`)).toBe('export const other = 1;\n')
    expect(inIndex(project, file)).toBe(VERSIONS.fixed)
    expect(project.read(file)).toBe(VERSIONS.fixed)
    expect(status(project)).toBe(`M  ${other}\n`)
  })

  it('fixes the files of `git commit -a` in the commit it makes', async () => {
    const project = hooked()

    project.write({ [file]: VERSIONS.staged, [other]: 'export const   other = 2\n' })

    const { exitCode, stderr } = await run(['git', 'commit', '--quiet', '--all', '--message=all'], {
      cwd: project.path('.'),
    })

    expect(exitCode).toBe(0)
    expect(report(stderr).at(-1)).toBe('✔ staged the fixes to src/extra.ts src/other.ts')
    expect(project.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
    expect(project.git('show', `HEAD:${other}`)).toBe('export const other = 2;\n')
    expect(status(project)).toBe('')
  })

  describe('in a linked worktree, whose hook git hands GIT_DIR', () => {
    it('sets the unstaged changes aside and puts them back', async () => {
      const project = hooked()
      const worktree = stagePartially(linkedWorktree(project, app), file)

      const { exitCode, stderr } = await run(['git', 'commit', '--quiet', '--message=extra'], {
        cwd: worktree.dir,
      })

      expect(exitCode).toBe(0)
      expect(report(stderr).slice(-2)).toEqual([
        '✔ staged the fixes to src/extra.ts',
        '○ unstaged changes of src/extra.ts restored',
      ])
      expect(worktree.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
      expect(worktree.read(file)).toBe(VERSIONS.merged)
      expect(status(worktree)).toBe(` M ${file}\n`)
      expect(project.exists('.git/worktrees/linked/uncheck-unstaged')).toBe(false)
    })

    it('fixes the files of `git commit <paths>` in the index the worktree keeps', async () => {
      const project = hooked()
      const worktree = linkedWorktree(project, app)

      stage(worktree, { [other]: 'export const other = 2;\n' })
      worktree.write({ [file]: VERSIONS.staged })

      const { exitCode, stderr } = await run(
        ['git', 'commit', '--quiet', '--message=extra', '--', file],
        { cwd: worktree.dir },
      )

      expect(exitCode).toBe(0)
      expect(report(stderr).at(-1)).toBe('✔ staged the fixes to src/extra.ts')
      expect(worktree.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
      expect(inIndex(worktree, file)).toBe(VERSIONS.fixed)
      expect(status(worktree)).toBe(`M  ${other}\n`)
      expect(status(project)).toBe('')
    })
  })
})
