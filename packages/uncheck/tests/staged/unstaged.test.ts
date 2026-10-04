import { lstatSync, readdirSync } from 'node:fs'

import { cliError, LAYOUTS, PERMISSIONS_ENFORCED, report, run, wrappedGit } from '../utils/project'
import {
  conflictError,
  expectFixesStaged,
  folderOf,
  inIndex,
  LEFTOVER_ERROR,
  SAVED_LINE,
  saveWhileTscRuns,
  stagePartially,
  stranded,
  STRANDED_HINT,
  strandedError,
  VERSIONS,
} from './utils'

describe.each(LAYOUTS)('uncheck staged with unstaged changes in a $name', ({ create, app }) => {
  const folder = folderOf(app)
  const file = `${app}src/extra.ts`

  it('checks the staged version of a partially staged file and puts the unstaged one back', async () => {
    const project = create({ [file]: VERSIONS.committed })

    project.stage({ [file]: VERSIONS.fixed })
    project.write({ [file]: `${VERSIONS.fixed}var   unstaged = 1\n` })

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--only=oxlint', '--only=oxfmt'],
      { cwd: folder },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ unstaged changes of src/extra.ts set aside until the checks finish',
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxfmt passed',
      '○ knip skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '○ unstaged changes of src/extra.ts restored',
      '✔ all checks passed (oxlint, oxfmt)',
    ])
    expect(project.read(file)).toBe(`${VERSIONS.fixed}var   unstaged = 1\n`)
    expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('puts unstaged lines back where they were after the fixes move lines around them', async () => {
    const split = 'export const list = [\n  1,\n  2,\n];\n'
    const joined = 'export const list = [1, 2];\n'
    const added =
      "\nexport function f() {\n  return 1;\n}\n\nexport function g() {\n  return 'g'\n}\n"
    const edit = (text: string) =>
      `${text.replace('  return 1;', '  // in f\n  return 1;')}\nexport const z = 1;\n`
    const fixed = added.replace("'g'", '"g";')
    const project = create({ [file]: joined, [`${app}src/other.ts`]: 'export const other = 1;\n' })

    project.stage({ [file]: split + added })
    project.write({
      [file]: split + edit(added),
      [`${app}src/other.ts`]: 'export const   other = 2\n',
      [`${app}src/fresh.ts`]: 'export const   fresh = 3\n',
    })

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout).slice(-3)).toEqual([
      '✔ staged the fixes to src/extra.ts',
      '○ unstaged changes of src/extra.ts restored',
      '✔ all checks passed (oxfmt)',
    ])
    expect(inIndex(project, file)).toBe(joined + fixed)
    expect(project.read(file)).toBe(joined + edit(fixed))
    expect(project.read(`${app}src/other.ts`)).toBe('export const   other = 2\n')
    expect(project.read(`${app}src/fresh.ts`)).toBe('export const   fresh = 3\n')
    expect(project.git('status', '--porcelain')).toBe(
      `MM ${file}\n M ${app}src/other.ts\n?? ${app}src/fresh.ts\n`,
    )
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('undoes every fix when one conflicts with unstaged changes, without running the post-checkout hook', async () => {
    const far = Array.from({ length: 30 }, (_, index) => `export const f${index} = ${index};\n`)
    const stagedFar = ['export const f0   =   0;\n', ...far.slice(1)].join('')
    const unstagedFar = [
      'export const f0   =   0;\n',
      ...far.slice(1, -1),
      'export const f29 = 30;\n',
    ].join('')
    const project = create({
      [file]: 'export const extra = 1;\n',
      [`${app}src/far.ts`]: far.join(''),
    })
      .write({ '.git/hooks/post-checkout': '#!/bin/sh\ntouch .git/post-checkout-ran\nexit 1\n' })
      .chmod('.git/hooks/post-checkout', 0o755)

    project.stage({
      [file]: 'export const   extra = 42\n',
      [`${app}src/far.ts`]: stagedFar,
      [`${app}src/other.ts`]: 'export const   other = 2\n',
    })
    project.write({
      [file]: 'export const   extra = 43\n',
      [`${app}src/far.ts`]: unstagedFar,
    })

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt'],
      { cwd: folder },
    )

    expect(stderr).toBe(cliError(conflictError('src/extra.ts')))
    expect(exitCode).toBe(1)
    expectFixesStaged(stdout, 'src/extra.ts src/far.ts src/other.ts', 'oxfmt')
    expect(inIndex(project, file)).toBe('export const   extra = 42\n')
    expect(inIndex(project, `${app}src/far.ts`)).toBe(stagedFar)
    expect(inIndex(project, `${app}src/other.ts`)).toBe('export const   other = 2\n')
    expect(project.read(file)).toBe('export const   extra = 43\n')
    expect(project.read(`${app}src/far.ts`)).toBe(unstagedFar)
    expect(project.read(`${app}src/other.ts`)).toBe('export const   other = 2\n')
    expect(project.git('status', '--porcelain')).toBe(
      `MM ${file}\nMM ${app}src/far.ts\nA  ${app}src/other.ts\n`,
    )
    expect(project.exists('.git/post-checkout-ran')).toBe(false)
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('undoes the fixes but keeps what is saved to a fully staged file while tsc runs', async () => {
    const other = `${app}src/other.ts`
    const plain = `${app}src/plain.ts`
    const project = create({ [file]: 'export const extra = 1;\n' })

    project.stage({
      [file]: 'export const   extra = 42\n',
      [other]: 'export const   other = 2\n',
      [plain]: 'export const   plain = 3\n',
    })
    project.write({ [file]: 'export const   extra = 43\n' })
    saveWhileTscRuns(project, [other])

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
      { cwd: folder },
    )

    expect(stderr).toBe(cliError(conflictError('src/extra.ts')))
    expect(exitCode).toBe(1)
    expectFixesStaged(stdout, 'src/extra.ts src/other.ts src/plain.ts', 'oxfmt, tsc')
    expect(inIndex(project, other)).toBe('export const   other = 2\n')
    expect(project.read(other)).toBe(`${SAVED_LINE}export const other = 2;\n`)
    expect(inIndex(project, plain)).toBe('export const   plain = 3\n')
    expect(project.read(plain)).toBe('export const   plain = 3\n')
    expect(project.read(file)).toBe('export const   extra = 43\n')
    expect(project.git('status', '--porcelain')).toBe(`MM ${file}\nAM ${other}\nA  ${plain}\n`)
  })

  it('undoes the fixes but keeps the merge of what is saved to a partially staged file while tsc runs', async () => {
    const conflicting = `${app}src/conflicting.ts`
    const project = stagePartially(
      create({ [file]: VERSIONS.committed, [conflicting]: 'export const c = 1;\n' }),
      file,
    )

    project.stage({ [conflicting]: 'export const   c = 42\n' })
    project.write({ [conflicting]: 'export const   c = 43\n' })
    saveWhileTscRuns(project, [file])

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
      { cwd: folder },
    )

    expect(stderr).toBe(cliError(conflictError('src/conflicting.ts')))
    expect(exitCode).toBe(1)
    expectFixesStaged(stdout, 'src/conflicting.ts src/extra.ts', 'oxfmt, tsc')
    expect(project.read(file)).toBe(SAVED_LINE + VERSIONS.merged)
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
    expect(project.read(conflicting)).toBe('export const   c = 43\n')
    expect(inIndex(project, conflicting)).toBe('export const   c = 42\n')
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('keeps an edit saved next to the unstaged changes while tsc runs, and their copy aside', async () => {
    const other = `${app}src/other.ts`
    const project = stagePartially(
      stagePartially(create({ [file]: VERSIONS.committed, [other]: VERSIONS.committed }), file),
      other,
    )

    saveWhileTscRuns(project, [file], { atEnd: true })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--only=tsc'], {
      cwd: folder,
    })

    const strandedLine = stranded(
      'src/extra.ts',
      'they conflict with edits saved while the checks ran',
    )

    expect(stderr).toBe(cliError(strandedError('src/extra.ts')))
    expect(exitCode).toBe(1)
    expect(report(stdout).slice(-2)).toEqual([strandedLine, '✔ all checks passed (tsc)'])
    expect(project.normalize(stdout)).toContain(`\n${strandedLine}\n${STRANDED_HINT}`)
    expect(project.read(file)).toBe(VERSIONS.staged + SAVED_LINE)
    expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe(VERSIONS.unstaged)
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
    expect(project.read(other)).toBe(VERSIONS.unstaged)
    expect(project.exists(`.git/uncheck-unstaged/${other}`)).toBe(false)
    expect(inIndex(project, other)).toBe(VERSIONS.staged)
  })

  it('refuses unstaged changes that are not edits to a file', async () => {
    const project = create({
      [`${app}src/a.ts`]: 'export const a = 1;\n',
      [`${app}src/b.ts`]: 'export const b = 1;\n',
    })

    project.stage({
      [`${app}src/a.ts`]: 'export const a = 2;\n',
      [`${app}src/b.ts`]: 'export const b = 2;\n',
    })
    project.write({ [`${app}src/a.ts`]: null, [`${app}src/b.ts`]: null })
    project.link(`${app}src/b.ts`, 'index.ts')

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--fix'], { cwd: folder })

    expect(stderr).toBe(
      cliError(
        'The unstaged changes of src/a.ts src/b.ts are not edits to a file and cannot be set aside. Stage or stash them, then commit again.',
      ),
    )
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
    expect(project.exists(`${app}src/a.ts`)).toBe(false)
    expect(lstatSync(project.path(`${app}src/b.ts`)).isSymbolicLink()).toBe(true)
    expect(project.git('status', '--porcelain')).toBe(`MD ${app}src/a.ts\nMT ${app}src/b.ts\n`)
  })

  it('stops rather than overwrite the unstaged changes an earlier run left behind', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    project.write({ [`.git/uncheck-unstaged/${file}`]: 'left behind' })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--fix'], { cwd: folder })

    expect(project.normalize(stderr)).toBe(cliError(LEFTOVER_ERROR))
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
    expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe('left behind')
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
  })

  it('stops on the unstaged changes an earlier run left behind even with none to set aside now', async () => {
    const project = create().stage({ [file]: 'export const   extra = 1\n' })

    project.write({ '.git/uncheck-unstaged/src/index.ts': 'left behind' })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--fix'], { cwd: folder })

    expect(project.normalize(stderr)).toBe(cliError(LEFTOVER_ERROR))
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
    expect(project.read('.git/uncheck-unstaged/src/index.ts')).toBe('left behind')
    expect(inIndex(project, file)).toBe('export const   extra = 1\n')
    expect(project.git('status', '--porcelain')).toBe(`A  ${file}\n`)
  })

  it('stops when a parallel run claims the folder for unstaged changes first', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--fix'], {
      cwd: folder,
      env: wrappedGit(
        'if [ "$1" = write-tree ]; then mkdir "$("$GIT" rev-parse --git-path uncheck-unstaged)"; fi',
      ),
    })

    expect(project.normalize(stderr)).toBe(cliError(LEFTOVER_ERROR))
    expect(exitCode).toBe(1)
    expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
    expect(readdirSync(project.path('.git/uncheck-unstaged'))).toEqual([])
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
  })

  it('keeps the unstaged mode of a file, whether or not the checks change it', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    project.chmod(file, 0o755)

    const checked = await project.uncheck(['staged', '--only=oxlint'], { cwd: folder })

    expect(checked.exitCode).toBe(0)
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(project.mode(file)).toBe(0o755)

    const fixed = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(fixed.exitCode).toBe(0)
    expect(inIndex(project, file)).toBe(VERSIONS.fixed)
    expect(project.git('ls-files', '--stage', '--', file)).toMatch(/^100644 /)
    expect(project.read(file)).toBe(VERSIONS.merged)
    expect(project.mode(file)).toBe(0o755)
  })

  it('keeps an edit a tool saves to a partially staged file while the checks run', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    project.fake(
      'oxlint',
      "const fs = require('node:fs')\nfs.writeFileSync('src/extra.ts', fs.readFileSync('src/extra.ts', 'utf8').replace('c = 1', 'c = 3'))\n",
    )

    const { exitCode, stdout } = await project.uncheck(['staged', '--only=oxlint'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout).slice(-2)).toEqual([
      '○ unstaged changes of src/extra.ts restored',
      '✔ all checks passed (oxlint)',
    ])
    expect(project.read(file)).toBe(VERSIONS.unstaged.replace('c = 1', 'c = 3'))
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
  })

  it('merges as plain text whatever merge driver the repository sets', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    project.write({ '.git/info/attributes': '*.ts merge=ours\n' })
    project.git('config', 'merge.ours.driver', 'true')

    const { exitCode } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(exitCode).toBe(0)
    expect(inIndex(project, file)).toBe(VERSIONS.fixed)
    expect(project.read(file)).toBe(VERSIONS.merged)
    expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
  })

  it('reads every unstaged change right, a rename among them', async () => {
    const project = stagePartially(
      create({ [file]: VERSIONS.committed, [`${app}src/aaa.ts`]: 'export const aaa = 1;\n' }),
      file,
    )

    project.git('mv', '--', `${app}src/aaa.ts`, `${app}src/moved.ts`)
    project.git('reset', '--quiet', '--', `${app}src/aaa.ts`, `${app}src/moved.ts`)
    project.git('add', '--intent-to-add', '--', `${app}src/moved.ts`)

    const { exitCode } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(exitCode).toBe(0)
    expect(inIndex(project, file)).toBe(VERSIONS.fixed)
    expect(project.read(file)).toBe(VERSIONS.merged)
    expect(project.git('status', '--porcelain')).toBe(
      `MM ${file}\n R ${app}src/aaa.ts -> ${app}src/moved.ts\n`,
    )
  })

  it('puts unstaged changes back from a folder whose name has a newline', async () => {
    const nested = `${app}new\nline/extra.ts`
    const project = stagePartially(create({ [nested]: VERSIONS.committed }), nested)

    const { exitCode } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: `${app}new\nline`,
    })

    expect(exitCode).toBe(0)
    expect(inIndex(project, nested)).toBe(VERSIONS.fixed)
    expect(project.read(nested)).toBe(VERSIONS.merged)
  })
})

describe.each(LAYOUTS)(
  'uncheck staged failing to handle unstaged changes in a $name',
  ({ create, app }) => {
    const folder = folderOf(app)
    const file = `${app}src/extra.ts`
    const saved = `.git/uncheck-unstaged/${file}`

    it.runIf(PERMISSIONS_ENFORCED)(
      'keeps the unstaged changes aside and stops when a check leaves the file unwritable',
      async () => {
        const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

        project.fake('oxlint', "require('node:fs').chmodSync('src/extra.ts', 0o444)\n")

        const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--only=oxlint'], {
          cwd: folder,
        })

        const output = project.normalize(stdout)
        const strandedLine = stranded(
          'src/extra.ts',
          `PlatformError: PermissionDenied: FileSystem.copyFile (<project>/${saved})`,
        )

        expect(stderr).toBe(cliError(strandedError('src/extra.ts')))
        expect(exitCode).toBe(1)
        expect(report(output)).toEqual([
          `uncheck staged in ${project.normalize(project.path(folder))}`,
          '○ unstaged changes of src/extra.ts set aside until the checks finish',
          '○ sherif skipped, not selected by --only',
          '▶ oxlint --no-error-on-unmatched-pattern src/extra.ts',
          '✔ oxlint passed',
          '○ oxfmt skipped, not selected by --only',
          '○ knip skipped, not selected by --only',
          '○ tsc skipped, not selected by --only',
          strandedLine,
          '✔ all checks passed (oxlint)',
        ])
        expect(output).toContain(`\n${strandedLine}\n${STRANDED_HINT}`)
        expect(project.read(saved)).toBe(VERSIONS.unstaged)
        expect(project.read(file)).toBe(VERSIONS.staged)
        expect(project.mode(file)).toBe(0o444)
        expect(inIndex(project, file)).toBe(VERSIONS.staged)
      },
    )

    it('keeps the unstaged changes aside and stops when a check replaces the file with a folder', async () => {
      const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

      project.fake(
        'oxlint',
        "const fs = require('node:fs')\nfs.rmSync('src/extra.ts')\nfs.mkdirSync('src/extra.ts')\n",
      )

      const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--only=oxlint'], {
        cwd: folder,
      })

      expect(stderr).toBe(cliError(strandedError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(project.normalize(stdout)).toContain(
        `${stranded('src/extra.ts', `git -c core.safecrlf=false hash-object -w --path=src/extra.ts [1 paths] failed: fatal: Unable to add ${file} to database`)}\n${STRANDED_HINT}`,
      )
      expect(project.read(saved)).toBe(VERSIONS.unstaged)
      expect(inIndex(project, file)).toBe(VERSIONS.staged)
    })

    it('keeps the fixes staged and the unstaged changes aside when git cannot write the merge back', async () => {
      const project = create({ [file]: VERSIONS.committed })

      project.write({ '.git/info/attributes': `${file} filter=once\n` })
      project.git('config', 'filter.once.clean', 'cat')
      project.git(
        'config',
        'filter.once.smudge',
        'if [ -e .git/smudged ]; then exit 1; fi; touch .git/smudged; cat',
      )
      project.git('config', 'filter.once.required', 'true')
      stagePartially(project, file)

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['staged', '--fix', '--only=oxfmt'],
        { cwd: folder },
      )

      const merged = await run(['git', 'hash-object', '--no-filters', '--stdin'], {
        cwd: project.dir,
        input: VERSIONS.merged,
      })

      expect(stderr).toBe(cliError(strandedError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(report(stdout).slice(-3)).toEqual([
        '✔ staged the fixes to src/extra.ts',
        stranded(
          'src/extra.ts',
          `git cat-file --filters --path=${file} ${merged.stdout.trim()} failed: error: external filter 'if [ -e .git/smudged ]; then exit 1; fi; touch .git/smudged; cat' failed 1`,
        ),
        '✔ all checks passed (oxfmt)',
      ])
      expect(inIndex(project, file)).toBe(VERSIONS.fixed)
      expect(project.read(file)).toBe(VERSIONS.fixed)
      expect(project.read(saved)).toBe(VERSIONS.unstaged)
    })

    it('keeps the fixes staged and the unstaged changes aside when git merge-file breaks', async () => {
      const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

      const { exitCode, stdout, stderr } = await project.uncheck(
        ['staged', '--fix', '--only=oxfmt'],
        {
          cwd: folder,
          env: wrappedGit(
            'if [ "$1" = merge-file ]; then echo "merge-file broke" >&2; exit 129; fi',
          ),
        },
      )

      expect(stderr).toBe(cliError(strandedError('src/extra.ts')))
      expect(exitCode).toBe(1)
      expect(report(stdout).at(-3)).toBe('✔ staged the fixes to src/extra.ts')
      expect(report(stdout).at(-1)).toBe('✔ all checks passed (oxfmt)')
      expect(report(stdout).at(-2)).toMatch(
        /^✘ could not put back the unstaged changes of src\/extra\.ts: git merge-file --quiet \S+\/result \S+\/base \S+\/fixed failed: merge-file broke$/,
      )
      expect(inIndex(project, file)).toBe(VERSIONS.fixed)
      expect(project.read(file)).toBe(VERSIONS.fixed)
      expect(project.read(saved)).toBe(VERSIONS.unstaged)
    })

    it.runIf(PERMISSIONS_ENFORCED)(
      'stops before touching a partially staged file it cannot read',
      async () => {
        const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

        project.chmod(file, 0o000)

        const { exitCode, stdout, stderr } = await project.uncheck(['staged'], { cwd: folder })

        expect(project.normalize(stderr)).toBe(
          cliError(`PermissionDenied: FileSystem.copyFile (<project>/${file})`),
        )
        expect(exitCode).toBe(1)
        expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
        expect(project.exists('.git/uncheck-unstaged')).toBe(false)
        expect(project.mode(file)).toBe(0o000)
        expect(project.chmod(file, 0o644).read(file)).toBe(VERSIONS.unstaged)
      },
    )

    it('puts back what it set aside when git fails to check out the staged versions', async () => {
      const other = `${app}src/other.ts`
      const project = create({ [file]: VERSIONS.committed, [other]: VERSIONS.committed })

      project.write({ '.git/info/attributes': `${other} filter=flaky\n` })
      project.git('config', 'filter.flaky.clean', 'cat')
      project.git(
        'config',
        'filter.flaky.smudge',
        'if [ -e .git/failed ]; then cat; else touch .git/failed; exit 1; fi',
      )
      project.git('config', 'filter.flaky.required', 'true')
      stagePartially(project, file)
      stagePartially(project, other)

      const { exitCode, stdout, stderr } = await project.uncheck(['staged'], {
        cwd: folder,
      })

      const filter =
        "external filter 'if [ -e .git/failed ]; then cat; else touch .git/failed; exit 1; fi' failed"

      expect(stderr).toBe(
        cliError(
          `git checkout-index -f [2 paths] failed: error: ${filter} 1\nerror: ${filter}\nfatal: ${other}: smudge filter flaky failed`,
        ),
      )
      expect(exitCode).toBe(1)
      expect(report(stdout)).toEqual([`uncheck staged in ${project.path(folder)}`])
      expect(project.read(file)).toBe(VERSIONS.unstaged)
      expect(project.read(other)).toBe(VERSIONS.unstaged)
      expect(project.git('status', '--porcelain')).toBe(`MM ${file}\nMM ${other}\n`)
      expect(project.exists('.git/uncheck-unstaged')).toBe(false)
    })
  },
)
