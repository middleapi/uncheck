import { createProject, eachLayout } from '../../_shared/project'
import { CLAUDE_STOP } from '../shell'

eachLayout('$layout', ({ layout }) => {
  it('stays silent when nothing changed since the last commit', async () => {
    const project = createProject(layout, { tools: [] })

    const { code, stdout, stderr } = await project.run(['hooks', 'run', '--fix'], {
      stdin: CLAUDE_STOP,
    })

    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toBe('')
  })

  it('checks the changed and untracked files, and passes quietly when they are clean', async () => {
    const project = createProject(layout)
    const math = project.inApp(layout === 'single' ? 'src/math.ts' : 'src/greet.ts')
    const fresh = project.inApp('src/fresh.ts')
    const ignored = project.inApp('dist/out.ts')

    project.write({
      [math]: `${project.read(math)}\nexport const extra = 1\n`,
      [fresh]: 'export const fresh = 3\n',
      [ignored]: 'var   ignored = 1',
    })
    // A staged change counts as much as one in the working tree.
    project.git('add', math)

    const { code, stdout, stderr } = await project.run(['hooks', 'run', '--fix'], {
      stdin: CLAUDE_STOP,
    })

    expect(stdout).toBe('')
    expect(stderr).toContain(`▶ oxlint --fix --no-error-on-unmatched-pattern ${fresh} ${math}\n`)
    expect(stderr).toContain(`▶ oxfmt --no-error-on-unmatched-pattern ${fresh} ${math}\n`)
    expect(stderr).toMatch(/✔ all checks passed \(oxlint, oxfmt, tsc\)\n$/)
    expect(code).toBe(0)
  })

  it('runs only the selected checks, and passes a change none of them covers unless required', async () => {
    const project = createProject(layout)
    const file = project.inApp('src/index.ts')

    project.write({ [file]: 'export const   answer: string = 1\n' })

    const fast = await project.run(['hooks', 'run', '--fix', '--only=oxlint', '--only=oxfmt'], {
      stdin: CLAUDE_STOP,
    })

    expect(fast.code).toBe(0)
    expect(fast.stdout).toBe('')
    expect(fast.stderr).toContain('○ tsc skipped, not selected by --only\n')
    expect(fast.stderr).toContain('✔ all checks passed (oxlint, oxfmt)')
    expect(project.read(file)).toBe('export const answer: string = 1\n')

    project.write({ [file]: "export const answer: string = '1'\n" })
    project.commit()
    project.write({ 'README.md': '# Project\n' })

    const optional = await project.run(['hooks', 'run', '--fix', '--only=tsc'], {
      stdin: CLAUDE_STOP,
    })

    expect(optional.code).toBe(0)
    expect(optional.stderr).toContain('○ nothing to check')

    const required = await project.run(['hooks', 'run', '--fix', '--only=tsc', '--require=tsc'], {
      stdin: CLAUDE_STOP,
    })

    expect(required.code).toBe(2)
    expect(required.stderr).toContain('tsc')
  })

  it('never takes a deleted file for a pattern that matches its neighbours', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: {
        [layout === 'single' ? 'app/[id].ts' : 'packages/app/src/[id].ts']: 'export const id = 1\n',
        [layout === 'single' ? 'app/i.ts' : 'packages/app/src/i.ts']: 'export const   i = 1\n',
      },
    })
    const neighbour = layout === 'single' ? 'app/i.ts' : 'packages/app/src/i.ts'

    project.remove(layout === 'single' ? 'app/[id].ts' : 'packages/app/src/[id].ts')

    const { code, stderr } = await project.run(['hooks', 'run', '--fix', '--only=oxfmt'], {
      stdin: CLAUDE_STOP,
    })

    expect(code).toBe(0)
    expect(stderr).not.toContain('i.ts')
    expect(project.read(neighbour)).toBe('export const   i = 1\n')
  })

  it('checks everything under the directory outside a git repository', async () => {
    const project = createProject(layout, { git: false })

    const { code, stderr } = await project.run(['hooks', 'run'], { stdin: '{}' })

    expect(stderr).toContain(`uncheck in ${project.root}\n`)
    expect(stderr).toContain('▶ oxlint\n')
    expect(stderr).toContain(
      layout === 'single'
        ? '✔ all checks passed (oxlint, oxfmt, tsc)'
        : '✔ all checks passed (sherif, oxlint, oxfmt, tsc)',
    )
    expect(code).toBe(0)

    // --cwd names the directory from anywhere.
    const elsewhere = await project.run(['hooks', 'run', '--cwd', project.app], {
      cwd: project.inApp('src'),
      stdin: '{}',
    })

    expect(elsewhere.stderr).toContain(`uncheck in ${project.app}\n`)
    expect(elsewhere.code).toBe(0)
  })
})
