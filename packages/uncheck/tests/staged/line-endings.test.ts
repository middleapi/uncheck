import { createProject, eachLayout } from '../_shared/project'
import { at, expectExit, inApp } from './helpers'

const crlf = (text: string) => text.replaceAll('\n', '\r\n')
const lines = 'export const a = 1\nexport const b = 2\nexport const c = 3\n'

eachLayout('$layout', ({ layout }) => {
  it('merges what git stores, so line endings a formatter rewrites are no change', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged, index } = at(project, project.appDir)
    const file = project.inApp('src/lines.ts')

    project.git('config', 'core.autocrlf', 'true')
    project.write({ [file]: crlf(`export const   answer = 43\n${lines}`) })
    project.git('add', file)
    project.write({ [file]: crlf(`export const   answer = 43\n${lines}export const d = 4\n`) })

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain('○ unstaged changes of src/lines.ts restored\n')
    expect(index('src/lines.ts')).toBe(`export const answer = 43\n${lines}`)
    expect(project.read(file)).toBe(crlf(`export const answer = 43\n${lines}export const d = 4\n`))
  })

  it('puts unstaged changes back with the line endings the package sets', async () => {
    const file = inApp(layout, 'src/lines.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: {
        [inApp(layout, '.gitattributes')]: '*.ts text eol=crlf\n',
        [file]: crlf(`export const answer = 42\n${lines}`),
      },
    })
    const { staged, index } = at(project, project.appDir)

    project.write({ [file]: crlf(`export const   answer = 43\n${lines}`) })
    project.git('add', file)
    project.write({ [file]: crlf(`export const   answer = 43\n${lines}export const d = 4\n`) })

    expectExit(await staged(['--fix', '--only=oxfmt']), 0)
    expect(index('src/lines.ts')).toBe(`export const answer = 43\n${lines}`)
    expect(project.read(file)).toBe(crlf(`export const answer = 43\n${lines}export const d = 4\n`))
  })

  it('undoes fixes to a file git keeps with CRLF line endings rather than turn them to LF', async () => {
    const kept = crlf('export const a = 1\nexport const b = 2\n')
    const file = inApp(layout, 'src/legacy.ts')
    // Committed with CRLF before text=auto, so git leaves those line endings alone.
    const project = createProject(layout, { tools: ['oxlint'], files: { [file]: kept } })
    const { staged, index } = at(project, project.appDir)
    const unstaged = `var c = 3\r\n${kept}export { c }\r\nexport const d = 4\r\n`

    project.write({ '.gitattributes': '* text=auto\n' })
    project.commit('attributes')
    project.write({ [file]: `var c = 3\r\n${kept}export { c }\r\n` })
    project.git('add', file)
    project.write({ [file]: unstaged })

    const result = await staged(['--fix', '--only=oxlint'])

    expectExit(result, 1)
    expect(result.stderr).toContain(
      'The fixes conflict with the unstaged changes of src/legacy.ts and were undone.',
    )
    expect(project.read(file)).toBe(unstaged)
    expect(index('src/legacy.ts')).toBe(`var c = 3\r\n${kept}export { c }\r\n`)
  })

  it('sees no change in a file git keeps with CRLF line endings under text=auto', async () => {
    const kept = crlf('export const a = 1\nexport const b = 2\n')
    const file = inApp(layout, 'src/legacy.ts')
    const project = createProject(layout, { tools: ['oxlint'], files: { [file]: kept } })
    const { staged } = at(project, project.appDir)

    project.write({ '.gitattributes': '* text=auto\n' })
    project.commit('attributes')
    project.git('config', 'core.safecrlf', 'true')
    project.write({ [file]: `${kept}export const c = 3\r\n` })
    project.git('add', file)
    project.write({ [file]: `${kept}export const c = 3\r\nexport const d = 4\r\n` })

    const result = await staged(['--only=oxlint'])

    expectExit(result, 0)
    expect(result.stdout).toContain('○ unstaged changes of src/legacy.ts restored\n')
    expect(project.read(file)).toBe(`${kept}export const c = 3\r\nexport const d = 4\r\n`)
    expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
  })
})
