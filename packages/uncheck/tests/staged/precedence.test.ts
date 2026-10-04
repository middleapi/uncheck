import { cliError, LAYOUTS, report } from '../utils/project'
import {
  conflictError,
  EMPTY_COMMIT_ERROR,
  folderOf,
  inIndex,
  stagePartially,
  stranded,
  STRANDED_HINT,
  strandedError,
  VERSIONS,
} from './utils'

describe.each(LAYOUTS)(
  'uncheck staged with a failed check and more in a $name',
  ({ create, app }) => {
    const folder = folderOf(app)
    const file = `${app}src/extra.ts`

    it('reports the fixes that conflict with unstaged changes over the failed check', async () => {
      const project = create({ [file]: 'export const extra: number = 1;\n' })

      project.stage({ [file]: 'export const   extra: number = "42"\n' })
      project.write({ [file]: 'export const   extra: number = "43"\n' })

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
        { cwd: folder },
      )

      expect(stderr).toBe(cliError(conflictError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(report(stdout).slice(-4)).toEqual([
        '✘ tsc failed',
        '○ fallow skipped, not selected by --only',
        '✔ staged the fixes to src/extra.ts',
        '✘ 1 of 2 checks failed: tsc',
      ])
      expect(inIndex(project, file)).toBe('export const   extra: number = "42"\n')
      expect(project.read(file)).toBe('export const   extra: number = "43"\n')
      expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
    })

    it('reports the unstaged changes it could not put back over the failed check', async () => {
      const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

      project.fake(
        'oxlint',
        "const fs = require('node:fs')\nfs.rmSync('src/extra.ts')\nfs.mkdirSync('src/extra.ts')\nprocess.exitCode = 1\n",
      )

      const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--only=oxlint'], {
        cwd: folder,
      })

      const strandedLine = stranded(
        'src/extra.ts',
        `git -c core.safecrlf=false hash-object -w --path=src/extra.ts [1 paths] failed: fatal: Unable to add ${file} to database`,
      )

      expect(stderr).toBe(cliError(strandedError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual([
        `uncheck staged in ${project.path(folder)}`,
        '○ unstaged changes of src/extra.ts set aside until the checks finish',
        '○ sherif skipped, not selected by --only',
        '▶ oxlint --no-error-on-unmatched-pattern src/extra.ts',
        '✘ oxlint failed',
        '○ oxfmt skipped, not selected by --only',
        '○ tsc skipped, not selected by --only',
        '○ fallow skipped, not selected by --only',
        strandedLine,
        '✘ 1 of 1 checks failed: oxlint',
        '  rerun with `--fix` to apply oxlint fixes',
      ])
      expect(project.normalize(stdout)).toContain(`\n${strandedLine}\n${STRANDED_HINT}`)
      expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe(VERSIONS.unstaged)
      expect(inIndex(project, file)).toBe(VERSIONS.staged)
      expect(project.git('status', '--porcelain')).toBe(`MD ${file}\n`)
    })

    it('reports a commit the fixes leave empty over the failed check', async () => {
      const project = create({
        [file]: 'export const extra = 1;\n',
        [`${app}src/broken.ts`]: 'export const broken: number = "1";\n',
      })

      project.stage({ [file]: 'export const   extra = 1\n' })

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
        { cwd: folder },
      )

      expect(stderr).toBe(cliError(EMPTY_COMMIT_ERROR))
      expect(exitCode).toBe(1)
      expect(report(stdout).slice(-4)).toEqual([
        '✘ tsc failed',
        '○ fallow skipped, not selected by --only',
        '✔ staged the fixes to src/extra.ts',
        '✘ 1 of 2 checks failed: tsc',
      ])
      expect(project.git('status', '--porcelain')).toBe('')
    })
  },
)
