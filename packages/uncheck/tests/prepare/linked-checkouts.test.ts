import { join } from 'node:path'

import type { Project } from '../utils/project'
import { CLI, LAYOUTS, monorepo, run, singleRepo, temporaryDirectory } from '../utils/project'
import { chmod, HEADER, hookLine, prepare, written } from './utils'

function addWorktree(project: Project): string {
  const worktree = join(temporaryDirectory(), 'wt')

  project.git('worktree', 'add', '--quiet', worktree)

  return worktree
}

describe.each(LAYOUTS)('prepare in a linked worktree of a $name', ({ create, app }) => {
  it('writes the hook the worktree shares with the main one, named by its full path', async () => {
    const project = create()
    const worktree = addWorktree(project)

    const { exitCode, stdout, stderr } = await run([...CLI, 'prepare', '--pre-commit'], {
      cwd: join(worktree, app),
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(project.path('.git/hooks/pre-commit'), 'created'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(project.exists('.git/worktrees/wt/hooks')).toBe(false)
  })
})

describe('prepare run by a git hook in a linked worktree of a monorepo', () => {
  it('enters the package folder although git exported the git folder of the worktree', async () => {
    const project = monorepo()
    const worktree = addWorktree(project)
    project.write({
      '.git/hooks/post-checkout': `#!/bin/sh\ncd packages/app && '${project.path('node_modules/.bin/uncheck')}' prepare --pre-commit\n`,
    })
    chmod(project, '.git/hooks/post-checkout', 0o755)

    const { exitCode, stderr } = await run(['git', 'checkout', '--quiet', '-b', 'feature'], {
      cwd: worktree,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe(written(project.path('.git/hooks/pre-commit'), 'created'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine('packages/app/')}\n`)
  })
})

describe.each(LAYOUTS)('prepare in a submodule that is a $name', ({ create, app }) => {
  it('writes the hook the superproject keeps for the submodule, named by its full path', async () => {
    const superproject = singleRepo()
    superproject.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      create().dir,
      'vendor/lib',
    )
    const hook = '.git/modules/vendor/lib/hooks/pre-commit'

    const { exitCode, stdout, stderr } = await prepare(superproject, [], {
      cwd: `vendor/lib/${app}`,
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(superproject.path(hook), 'created'))
    expect(superproject.read(hook)).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(superproject.exists('.git/hooks/pre-commit')).toBe(false)
  })
})
