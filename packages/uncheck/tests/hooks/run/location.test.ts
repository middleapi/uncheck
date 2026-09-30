import process from 'node:process'

import { createProject, eachLayout } from '../../_shared/project'
import { CLAUDE_STOP, inTerminal } from '../shell'

eachLayout('$layout', ({ layout }) => {
  // The folder a hook names with --dir, and a file outside it.
  const target = layout === 'single' ? 'src' : 'packages/app'
  const outside = layout === 'single' ? 'scripts/build.ts' : 'packages/lib/src/index.ts'

  it('checks the top of the repository wherever the agent moved to', async () => {
    const project = createProject(layout)
    const file = project.inApp('src/index.ts')

    project.write({ [file]: 'export const answer: string = 1\n' })

    const { code, stderr } = await project.run(['hooks', 'run', '--fix'], {
      cwd: project.inApp('src'),
      stdin: CLAUDE_STOP,
    })

    expect(code).toBe(2)
    expect(stderr).toContain(`uncheck in ${project.root}\n`)
    expect(stderr).toContain(`${file}(1,14): error TS2322`)
  })

  it('checks the directory in --dir, from wherever the agent is', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [outside]: 'export const outside = 1\n' },
    })
    const file = project.inApp('src/index.ts')

    project.write({
      [file]: 'export const   answer = 1\n',
      [outside]: 'export const   outside = 2\n',
    })

    const { code, stderr } = await project.run(
      ['hooks', 'run', '--fix', '--only=oxfmt', `--dir=${target}`],
      { cwd: outside.replace(/\/[^/]+$/, ''), stdin: CLAUDE_STOP },
    )

    expect(code).toBe(0)
    expect(stderr).toContain(`uncheck in ${project.path(target)}\n`)
    expect(stderr).toContain(
      `▶ oxfmt --no-error-on-unmatched-pattern ${layout === 'single' ? 'index.ts' : 'src/index.ts'}\n`,
    )
    expect(project.read(file)).toBe('export const answer = 1\n')
    expect(project.read(outside)).toBe('export const   outside = 2\n')
  })

  it('reports a --dir that names nothing instead of sending the agent back', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const file = project.inApp('src/index.ts')

    project.write({ [file]: 'export const   answer = 1\n' })

    const { code, stdout, stderr } = await project.run(
      ['hooks', 'run', '--fix', '--dir=packages/gone'],
      { stdin: CLAUDE_STOP },
    )

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain(
      `--dir=packages/gone names nothing in ${project.root}, run \`uncheck hooks install\` again from the project`,
    )
    expect(project.read(file)).toBe('export const   answer = 1\n')
  })

  it.runIf(process.platform === 'linux')(
    'refuses to run with a terminal on stdin, where no agent payload can come from',
    async () => {
      const project = createProject(layout, { tools: [] })

      const { code, stdout } = await inTerminal(project, ['hooks', 'run', '--fix'])

      expect(code).toBe(1)
      expect(stdout).toContain(
        '`uncheck hooks run` expects the agent hook payload as JSON on stdin',
      )
    },
  )
})
