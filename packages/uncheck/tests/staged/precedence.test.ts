import { LAYOUTS, report } from '../utils/project'
import {
  conflictError,
  EMPTY_COMMIT_ERROR,
  failure,
  folderOf,
  inIndex,
  normalized,
  stage,
  stagePartially,
  status,
  stranded,
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

      stage(project, { [file]: 'export const   extra: number = "42"\n' })
      project.write({ [file]: 'export const   extra: number = "43"\n' })

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
        { cwd: folder },
      )

      expect(stderr).toBe(failure(conflictError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(report(stdout).slice(-3)).toEqual([
        '✘ tsc failed',
        '✘ 1 of 2 checks failed: tsc',
        '✔ staged the fixes to src/extra.ts',
      ])
      expect(inIndex(project, file)).toBe('export const   extra: number = "42"\n')
      expect(project.read(file)).toBe('export const   extra: number = "43"\n')
    })

    it('reports the unstaged changes it could not put back over the failed check', async () => {
      const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

      project.fake(
        'oxlint',
        "require('node:fs').chmodSync('src/extra.ts', 0o444)\nprocess.exitCode = 1\n",
      )

      const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--only=oxlint'], {
        cwd: folder,
      })

      expect(stderr).toBe(failure(strandedError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(report(normalized(project, stdout)).slice(-6)).toEqual([
        '✘ oxlint failed',
        '○ oxfmt skipped, not selected by --only',
        '○ tsc skipped, not selected by --only',
        '✘ 1 of 1 checks failed: oxlint',
        '  rerun with `--fix` to apply oxlint fixes',
        stranded(
          'src/extra.ts',
          `PlatformError: PermissionDenied: FileSystem.copyFile (<project>/.git/uncheck-unstaged/${file})`,
        ),
      ])
      expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe(VERSIONS.unstaged)
    })

    it('reports a commit the fixes leave empty over the failed check', async () => {
      const project = create({
        [file]: 'export const extra = 1;\n',
        [`${app}src/broken.ts`]: 'export const broken: number = "1";\n',
      })

      stage(project, { [file]: 'export const   extra = 1\n' })

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
        { cwd: folder },
      )

      expect(stderr).toBe(failure(EMPTY_COMMIT_ERROR))
      expect(exitCode).toBe(1)
      expect(report(stdout).slice(-3)).toEqual([
        '✘ tsc failed',
        '✘ 1 of 2 checks failed: tsc',
        '✔ staged the fixes to src/extra.ts',
      ])
      expect(status(project)).toBe('')
    })
  },
)
