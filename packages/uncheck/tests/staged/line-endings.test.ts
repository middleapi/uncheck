import { cliError, LAYOUTS } from '../utils/project'
import { conflictError, folderOf, inIndex } from './utils'

const crlf = (text: string) => text.replaceAll('\n', '\r\n')

const LINES = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n'

describe.each(LAYOUTS)('uncheck staged with CRLF files in a $name', ({ create, app }) => {
  const folder = folderOf(app)
  const file = `${app}src/crlf.ts`

  it('merges what git stores under core.autocrlf, so rewritten line endings are no change', async () => {
    const project = create({ [file]: `export const answer: number = 42;\n${LINES}` })

    project.git('config', 'core.autocrlf', 'true')
    project.stage({ [file]: crlf(`export const   answer: number = 43\n${LINES}`) })
    project.write({
      [file]: crlf(`export const   answer: number = 43\n${LINES}export const d = 4;\n`),
    })

    const { exitCode } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(exitCode).toBe(0)
    expect(inIndex(project, file)).toBe(`export const answer: number = 43;\n${LINES}`)
    expect(project.read(file)).toBe(
      crlf(`export const answer: number = 43;\n${LINES}export const d = 4;\n`),
    )
  })

  it('puts unstaged changes back with the line endings the package sets', async () => {
    const project = create({
      [`${app}.gitattributes`]: '*.ts text eol=crlf\n',
      [file]: crlf(`export const answer: number = 42;\n${LINES}`),
    })

    project.stage({ [file]: crlf(`export const   answer: number = 43\n${LINES}`) })
    project.write({
      [file]: crlf(`export const   answer: number = 43\n${LINES}export const d = 4;\n`),
    })

    const { exitCode } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(exitCode).toBe(0)
    expect(inIndex(project, file)).toBe(`export const answer: number = 43;\n${LINES}`)
    expect(project.read(file)).toBe(
      crlf(`export const answer: number = 43;\n${LINES}export const d = 4;\n`),
    )
  })

  describe('that git keeps with CRLF under text=auto', () => {
    const kept = 'export const a = 1;\r\nexport const b = 2;\r\n'

    function legacy() {
      const project = create({ [file]: kept })

      return project.write({ '.gitattributes': '* text=auto\n' }).commit('attributes')
    }

    it('sees no change where nothing changed it', async () => {
      const project = legacy()
      const unstaged = `${kept}export const c = 3;\r\nexport const d = 4;\r\n`

      project.git('config', 'core.safecrlf', 'true')
      project.stage({ [file]: `${kept}export const c = 3;\r\n` })
      project.write({ [file]: unstaged })

      const { exitCode, stderr } = await project.uncheck(['staged', '--only=oxlint'], {
        cwd: folder,
      })

      expect(stderr).toBe('')
      expect(exitCode).toBe(0)
      expect(project.read(file)).toBe(unstaged)
      expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
    })

    it('undoes its fixes rather than turn its line endings to LF', async () => {
      const project = legacy()
      const unstaged = `var c = 3;\r\n${kept}export { c };\r\nexport const d = 4;\r\n`

      project.stage({ [file]: `var c = 3;\r\n${kept}export { c };\r\n` })
      project.write({ [file]: unstaged })

      const { exitCode, stderr } = await project.uncheck(['staged', '--fix', '--only=oxlint'], {
        cwd: folder,
      })

      expect(stderr).toBe(cliError(conflictError('src/crlf.ts')))
      expect(exitCode).toBe(1)
      expect(project.read(file)).toBe(unstaged)
      expect(inIndex(project, file)).toBe(`var c = 3;\r\n${kept}export { c };\r\n`)
    })
  })
})
