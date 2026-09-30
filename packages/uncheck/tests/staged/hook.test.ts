import { symlinkSync } from 'node:fs'

import { createProject, eachLayout } from '../_shared/project'
import { commitOnSide, gitTry, inApp, preCommitHook } from './helpers'

/** Each layout commits through a pre-commit hook that runs where its own hook would: the package folder. */
eachLayout('$layout', ({ layout }) => {
  it('commits the fixes and keeps the unstaged changes out of the commit', () => {
    const file = inApp(layout, 'src/hooked.ts')
    const body = 'export const a = 1\nexport const b = 2\nexport const c = 3\n'
    const project = createProject(layout, { files: { [file]: body } })

    preCommitHook(project, 'staged --fix', project.appDir || '.')
    project.write({ [file]: `export const   answer = 42;\n${body}` })
    project.git('add', file)
    project.write({ [file]: `export const   answer = 42;\n${body}export const d = 4\n` })

    const commit = gitTry(project, '.', 'commit', '-m', 'hooked')

    expect(commit.status, commit.stdout + commit.stderr).toBe(0)
    // git hands what a hook prints to stderr.
    expect(commit.stderr).toContain('✔ all checks passed (oxlint, oxfmt, tsc)\n')
    expect(project.git('show', `HEAD:${file}`)).toBe(`export const answer = 42\n${body}`)
    expect(project.read(file)).toBe(`export const answer = 42\n${body}export const d = 4\n`)
    expect(project.git('status', '--porcelain')).toBe(` M ${file}\n`)
  })

  it('stops a commit whose staged files fail a check', () => {
    const file = inApp(layout, 'src/broken.ts')
    const project = createProject(layout)

    preCommitHook(project, 'staged --fix', project.appDir || '.')
    project.write({ [file]: 'export const broken: string = 1\n' })
    project.git('add', file)

    const head = project.git('rev-parse', 'HEAD')
    const commit = gitTry(project, '.', 'commit', '-m', 'broken')

    expect(commit.status).not.toBe(0)
    expect(commit.stderr).toContain('TS2322')
    expect(commit.stderr).toContain('✘ 1 of 3 checks failed: tsc\n')
    expect(project.git('rev-parse', 'HEAD')).toBe(head)
  })

  it('stages the fixes in the index `git commit <paths>` leaves behind, not only in its own', () => {
    const file = inApp(layout, 'src/only.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [file]: 'export const only = 1\n' },
    })

    preCommitHook(project, 'staged --fix --only=oxfmt', project.appDir || '.')
    project.write({ [file]: 'export const   only = 2\n' })

    const commit = gitTry(project, '.', 'commit', '-m', 'only', file)

    expect(commit.status, commit.stdout + commit.stderr).toBe(0)
    expect(project.git('show', `HEAD:${file}`)).toBe('export const only = 2\n')
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('runs from a package folder of a linked worktree, whose hook git hands GIT_DIR', () => {
    const file = inApp(layout, 'src/tree.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: {
        '.gitignore': 'node_modules\nworktrees\n',
        [file]: 'export const tree = 1\n',
      },
    })
    const worktree = 'worktrees/wt'

    preCommitHook(project, 'staged --fix --only=oxfmt', project.appDir || '.')
    project.git('worktree', 'add', '--quiet', worktree)
    symlinkSync(project.path('node_modules'), project.path(`${worktree}/node_modules`))
    project.write({ [`${worktree}/${file}`]: 'export const   tree = 2\n' })

    // `-a` runs the hook on the index lock itself.
    const commit = gitTry(project, worktree, 'commit', '-am', 'tree')

    expect(commit.status, commit.stdout + commit.stderr).toBe(0)
    expect(project.gitIn(worktree, 'show', `HEAD:${file}`)).toBe('export const tree = 2\n')
    expect(project.gitIn(worktree, 'status', '--porcelain')).toBe('')
  })

  it('stops a commit the fixes would leave empty, unless the hook allows it', () => {
    const file = inApp(layout, 'src/empty.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [file]: 'export const empty = 1\n' },
    })

    preCommitHook(project, 'staged --fix --only=oxfmt', project.appDir || '.')
    project.write({ [file]: 'export const   empty = 1\n' })
    project.git('add', file)

    const head = project.git('rev-parse', 'HEAD')
    const stopped = gitTry(project, '.', 'commit', '-m', 'empty')

    expect(stopped.status).not.toBe(0)
    expect(stopped.stderr).toContain(
      'The fixes undid every staged change, so the commit would be empty.',
    )
    expect(project.git('rev-parse', 'HEAD')).toBe(head)

    preCommitHook(project, 'staged --fix --only=oxfmt --allow-empty', project.appDir || '.')
    project.write({ [file]: 'export const   empty = 1\n' })
    project.git('add', file)

    const allowed = gitTry(project, '.', 'commit', '--allow-empty', '-m', 'empty')

    expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0)
    expect(project.git('rev-parse', 'HEAD~1')).toBe(head)
    expect(project.git('diff', 'HEAD~1', 'HEAD', '--name-only')).toBe('')
  })

  it('records a merge whose tree the fixes turn back into what HEAD has', () => {
    const file = inApp(layout, 'src/merged.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [file]: 'export const merged = 1\n' },
    })

    preCommitHook(project, 'staged --fix --only=oxfmt', project.appDir || '.')
    commitOnSide(project, { [file]: 'export const merged = 2\n' })
    project.git('merge', '--quiet', '--no-commit', '--no-ff', 'side')
    project.write({ [file]: 'export const   merged = 1\n' })
    project.git('add', file)

    const commit = gitTry(project, '.', 'commit', '--no-edit')

    expect(commit.status, commit.stdout + commit.stderr).toBe(0)
    expect(project.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(project.git('show', `HEAD:${file}`)).toBe('export const merged = 1\n')
  })
})
