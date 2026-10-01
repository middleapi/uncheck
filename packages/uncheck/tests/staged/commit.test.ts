import { cliError, LAYOUTS, linkedWorktree, report, run } from '../utils/project'
import type { Project } from '../utils/project'
import {
  EMPTY_COMMIT_ERROR,
  inIndex,
  SAVED_LINE,
  saveWhileTscRuns,
  stagePartially,
  VERSIONS,
} from './utils'

const ALL_PASSED = '✔ all checks passed (oxlint, oxfmt, tsc)'

describe.each(LAYOUTS)('uncheck staged as the pre-commit hook of a $name', ({ create, app }) => {
  const file = `${app}src/extra.ts`
  const other = `${app}src/other.ts`

  function hooked(): Project {
    return create({ [file]: VERSIONS.committed, [other]: 'export const other = 1;\n' })
      .write({
        '.git/hooks/pre-commit': `#!/bin/sh\n(cd "./${app}" && pnpm exec uncheck staged --fix) || exit 1\n`,
      })
      .chmod('.git/hooks/pre-commit', 0o755)
  }

  function commit(project: Project, ...args: ReadonlyArray<string>) {
    return run(['git', 'commit', '--quiet', ...args], { cwd: project.dir })
  }

  it('fixes the files of `git commit <paths>` in the commit and in the index it leaves', async () => {
    const project = hooked().stage({ [other]: 'export const other = 2;\n' })

    project.write({ [file]: VERSIONS.staged })
    saveWhileTscRuns(project, [file])

    const { exitCode, stderr } = await commit(project, '--message=extra', '--', file)

    expect(exitCode).toBe(0)
    expect(report(stderr).slice(-2)).toEqual(['✔ staged the fixes to src/extra.ts', ALL_PASSED])
    expect(project.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
    expect(project.git('show', `HEAD:${other}`)).toBe('export const other = 1;\n')
    expect(inIndex(project, file)).toBe(VERSIONS.fixed)
    expect(project.read(file)).toBe(SAVED_LINE + VERSIONS.fixed)
    expect(project.git('status', '--porcelain')).toBe(` M ${file}\nM  ${other}\n`)
  })

  it('fixes the files of `git commit -a` in the commit it makes', async () => {
    const project = hooked()

    project.write({ [file]: VERSIONS.staged, [other]: 'export const   other = 2\n' })

    const { exitCode, stderr } = await run(['git', 'commit', '--quiet', '--all', '--message=all'], {
      cwd: project.dir,
    })

    expect(exitCode).toBe(0)
    expect(report(stderr).slice(-2)).toEqual([
      '✔ staged the fixes to src/extra.ts src/other.ts',
      ALL_PASSED,
    ])
    expect(project.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
    expect(project.git('show', `HEAD:${other}`)).toBe('export const other = 2;\n')
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('commits the fixes as the fixers left them, without what is saved while tsc runs', async () => {
    const clean = `${app}src/clean.ts`
    const project = stagePartially(
      hooked().stage({
        [other]: 'export const   other = 2\n',
        [clean]: 'export const clean = 1;\n',
      }),
      file,
    )

    saveWhileTscRuns(project, [file, other, clean])

    const { exitCode, stderr } = await commit(project, '--message=saved')

    expect(exitCode).toBe(0)
    expect(report(stderr).slice(-3)).toEqual([
      '✔ staged the fixes to src/extra.ts src/other.ts',
      '○ unstaged changes of src/extra.ts restored',
      ALL_PASSED,
    ])
    expect(project.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
    expect(project.git('show', `HEAD:${other}`)).toBe('export const other = 2;\n')
    expect(project.git('show', `HEAD:${clean}`)).toBe('export const clean = 1;\n')
    expect(project.read(file)).toBe(SAVED_LINE + VERSIONS.merged)
    expect(project.read(other)).toBe(`${SAVED_LINE}export const other = 2;\n`)
    expect(project.read(clean)).toBe(`${SAVED_LINE}export const clean = 1;\n`)
    expect(project.git('status', '--porcelain')).toBe(` M ${clean}\n M ${file}\n M ${other}\n`)
  })

  it('ends a blocked commit with the summary of the checks', async () => {
    const project = stagePartially(
      hooked().stage({ [`${app}src/broken.ts`]: 'export const broken: number = "1";\n' }),
      file,
    )

    const { exitCode, stderr } = await commit(project, '--message=broken')

    expect(exitCode).toBe(1)
    expect(report(stderr).slice(-3)).toEqual([
      '✔ staged the fixes to src/extra.ts',
      '○ unstaged changes of src/extra.ts restored',
      '✘ 1 of 3 checks failed: tsc',
    ])
    expect(stderr).toMatch(/\n✘ 1 of 3 checks failed: tsc\n$/)
    expect(project.git('log', '--format=%s')).toBe('init\n')
  })

  it('blocks a commit the fixes empty, which git amends or refuses when run again', async () => {
    const project = hooked()
    const unformatted = { [other]: 'export const   other = 1\n' }

    project.stage(unformatted)

    const amend = await commit(project, '--amend', '--message=reworded')

    expect(amend.stderr).toContain(cliError(EMPTY_COMMIT_ERROR))
    expect(amend.exitCode).toBe(1)
    expect(project.git('log', '--format=%s')).toBe('init\n')
    expect((await commit(project, '--amend', '--message=reworded')).exitCode).toBe(0)
    expect(project.git('log', '--format=%s')).toBe('reworded\n')

    project.stage(unformatted)

    const plain = await commit(project, '--message=empty')

    expect(plain.stderr).toContain(cliError(EMPTY_COMMIT_ERROR))
    expect(plain.exitCode).toBe(1)

    const again = await commit(project, '--message=empty')

    expect(again.stdout).toContain('nothing to commit')
    expect(again.exitCode).toBe(1)
    expect(project.git('log', '--format=%s')).toBe('reworded\n')
    expect(project.git('status', '--porcelain')).toBe('')
  })

  describe('in a linked worktree, whose hook git hands GIT_DIR', () => {
    it('sets the unstaged changes aside and puts them back', async () => {
      const project = hooked()
      const worktree = stagePartially(linkedWorktree(project, app), file)

      const { exitCode, stderr } = await run(['git', 'commit', '--quiet', '--message=extra'], {
        cwd: worktree.dir,
      })

      expect(exitCode).toBe(0)
      expect(report(stderr).slice(-3)).toEqual([
        '✔ staged the fixes to src/extra.ts',
        '○ unstaged changes of src/extra.ts restored',
        ALL_PASSED,
      ])
      expect(worktree.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
      expect(worktree.read(file)).toBe(VERSIONS.merged)
      expect(worktree.git('status', '--porcelain')).toBe(` M ${file}\n`)
      expect(project.exists('.git/worktrees/linked/uncheck-unstaged')).toBe(false)
    })

    it('fixes the files of `git commit <paths>` in the index the worktree keeps', async () => {
      const project = hooked()
      const worktree = linkedWorktree(project, app).stage({ [other]: 'export const other = 2;\n' })

      worktree.write({ [file]: VERSIONS.staged })

      const { exitCode, stderr } = await run(
        ['git', 'commit', '--quiet', '--message=extra', '--', file],
        { cwd: worktree.dir },
      )

      expect(exitCode).toBe(0)
      expect(report(stderr).slice(-2)).toEqual(['✔ staged the fixes to src/extra.ts', ALL_PASSED])
      expect(worktree.git('show', `HEAD:${file}`)).toBe(VERSIONS.fixed)
      expect(inIndex(worktree, file)).toBe(VERSIONS.fixed)
      expect(worktree.git('status', '--porcelain')).toBe(`M  ${other}\n`)
      expect(project.git('status', '--porcelain')).toBe('')
    })
  })
})
