import { copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import process from 'node:process'

import { createProject, eachLayout } from '../_shared/project'
import { at, expectExit, inApp } from './helpers'

eachLayout('$layout', ({ layout }) => {
  it.skipIf(process.platform === 'win32')(
    'checks a symlink turned into a file, never what a staged symlink points to',
    async () => {
      const project = createProject(layout, { tools: ['oxfmt'] })
      const { staged, index } = at(project, project.appDir)
      const [link, alias, other] = ['src/link.ts', 'src/alias.ts', 'src/other.ts'].map((file) =>
        project.inApp(file),
      ) as [string, string, string]

      project.write({ [other]: 'export const other = 2\n' })
      symlinkSync('other.ts', project.path(link))
      project.commit('link')
      rmSync(project.path(link))
      project.write({ [link]: 'export const   link = 1\n' })
      symlinkSync('other.ts', project.path(alias))
      project.git('add', link, alias)
      project.write({ [other]: 'export const   other = 3\n' })

      const result = await staged(['--fix', '--only=oxfmt'])

      expectExit(result, 0)
      expect(result.stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/link.ts\n')
      expect(result.stdout).toContain('✔ staged the fixes to src/link.ts\n')
      expect(index('src/link.ts')).toBe('export const link = 1\n')
      expect(project.read(other)).toBe('export const   other = 3\n')
      expect(project.git('status', '--porcelain')).toBe(`A  ${alias}\nT  ${link}\n M ${other}\n`)
    },
  )

  it('refuses to set aside a staged file whose unstaged change is a symlink', async () => {
    const project = createProject(layout, { tools: [] })
    const { staged } = at(project, project.appDir)
    const file = project.inApp('src/turned.ts')

    project.write({ [file]: 'export const turned = 1\n' })
    project.git('add', file)
    rmSync(project.path(file))
    symlinkSync('index.ts', project.path(file))

    const result = await staged(['--fix'])

    expectExit(result, 1)
    expect(result.stderr).toContain(
      'The unstaged changes of src/turned.ts are not edits to a file and cannot be set aside.',
    )
  })

  it('never stages the commit a submodule has checked out but not staged', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged } = at(project, project.appDir)
    const sub = project.inApp('sub')
    const file = project.inApp('src/next.ts')

    mkdirSync(project.path(sub))
    project.gitIn(sub, 'init', '--quiet')
    project.gitIn(sub, 'commit', '--quiet', '--allow-empty', '-m', 'one')
    project.git('add', sub)
    project.gitIn(sub, 'commit', '--quiet', '--allow-empty', '-m', 'two')
    project.write({ [file]: 'export const   next = 1\n' })
    project.git('add', sub, file)
    project.gitIn(sub, 'commit', '--quiet', '--allow-empty', '-m', 'three')

    const pinned = project.git('rev-parse', `:${sub}`)
    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/next.ts\n')
    expect(project.git('rev-parse', `:${sub}`)).toBe(pinned)
    expect(project.git('show', `:${file}`)).toBe('export const next = 1\n')
  })

  it('reports what git refused to do instead of crashing', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged } = at(project, project.appDir)
    const file = project.inApp('src/locked.ts')

    project.write({ [file]: 'export const   locked = 1\n' })
    project.git('add', file)
    // A lock left behind by another git process makes every write to the index fail.
    project.write({ '.git/index.lock': '' })

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 1)
    expect(result.stderr).toMatch(/git update-index \[1 paths\] failed: .*index\.lock/)
  })

  it('stages in the index it is given, and in no lock that is not there', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged } = at(project, project.appDir)
    const file = project.inApp('src/other.ts')

    project.write({ [file]: 'export const   other = 1\n' })
    project.git('add', file)
    // An index of its own whose name ends like the one `git commit <paths>` hands its hook.
    copyFileSync(project.path('.git/index'), project.path('.git/other-index.lock'))
    project.git('reset', '--quiet')

    const result = await staged(['--fix', '--only=oxfmt'], {
      env: { GIT_INDEX_FILE: project.path('.git/other-index.lock') },
    })

    expectExit(result, 0)
    expect(result.stdout).toContain('✔ staged the fixes to src/other.ts\n')
    expect(project.exists('.git/index.lock')).toBe(false)
    expect(project.git('--literal-pathspecs', 'status', '--porcelain', '--', file)).toBe(
      `?? ${file}\n`,
    )
    expect(project.read(file)).toBe('export const other = 1\n')
  })

  it('checks a staged file whose name git quotes', async () => {
    const file = inApp(layout, 'src/tab\there "quoted".ts')
    const rest = 'export const x = 1\nexport const y = 1\nexport const z = 1\n'
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [file]: `export const q = 1\n${rest}` },
    })
    const { staged, index } = at(project, project.appDir)

    project.write({ [file]: `export const   q = 2\n${rest}` })
    project.git('add', file)
    project.write({ [file]: `export const   q = 2\n${rest}export const r = 3\n` })

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(index('src/tab\there "quoted".ts')).toBe(`export const q = 2\n${rest}`)
    expect(project.read(file)).toBe(`export const q = 2\n${rest}export const r = 3\n`)
  })
})
