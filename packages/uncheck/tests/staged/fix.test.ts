import { mkdirSync } from 'node:fs'

import { cliError, git, LAYOUTS, report } from '../utils/project'
import { EMPTY_COMMIT_ERROR, folderOf, inIndex } from './utils'

describe.each(LAYOUTS)('uncheck staged --fix in a $name', ({ create, app, tsc }) => {
  const folder = folderOf(app)

  it('applies the lint and format fixes and stages them', async () => {
    const project = create().stage({
      [`${app}src/index.ts`]: 'var   answer = 42\nexport { answer }\n',
    })

    const { exitCode, stdout, stderr } = await project.uncheck(['staged', '--fix'], { cwd: folder })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern src/index.ts',
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
      '✔ staged the fixes to src/index.ts',
    ])
    expect(inIndex(project, `${app}src/index.ts`)).toBe('const answer = 42;\nexport { answer };\n')
    expect(project.read(`${app}src/index.ts`)).toBe('const answer = 42;\nexport { answer };\n')
    expect(project.git('status', '--porcelain')).toBe(`M  ${app}src/index.ts\n`)
  })

  it('stages the fixes even when a check still fails', async () => {
    const project = create().stage({
      [`${app}src/index.ts`]: 'export const   answer: number = "42"\n',
    })

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt', '--only=tsc'],
      { cwd: folder },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(1)
    expect(report(stdout).slice(-2)).toEqual([
      '✘ 1 of 2 checks failed: tsc',
      '✔ staged the fixes to src/index.ts',
    ])
    expect(inIndex(project, `${app}src/index.ts`)).toBe('export const answer: number = "42";\n')
  })

  it('stages nothing when the fixes change nothing', async () => {
    const project = create().stage({ [`${app}src/extra.ts`]: 'export const extra = 1;\n' })

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout).at(-1)).toBe('✔ all checks passed (oxfmt)')
    expect(project.git('status', '--porcelain')).toBe(`A  ${app}src/extra.ts\n`)
  })

  it('fails when the fixes undo every staged change, unless empty commits are allowed', async () => {
    const project = create({ [`${app}src/extra.ts`]: 'export const extra = 1;\n' })
    const unformatted = { [`${app}src/extra.ts`]: 'export const   extra = 1\n' }

    project.stage(unformatted)

    const empty = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(empty.stderr).toBe(cliError(EMPTY_COMMIT_ERROR))
    expect(empty.exitCode).toBe(1)
    expect(report(empty.stdout).at(-1)).toBe('✔ staged the fixes to src/extra.ts')
    expect(project.git('status', '--porcelain')).toBe('')

    project.stage(unformatted)

    const allowed = await project.uncheck(['staged', '--fix', '--allow-empty', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(allowed.stderr).toBe('')
    expect(allowed.exitCode).toBe(0)
    expect(report(allowed.stdout).at(-1)).toBe('✔ staged the fixes to src/extra.ts')
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('reports why git refused to stage the fixes', async () => {
    const project = create().stage({ [`${app}src/extra.ts`]: 'export const   extra = 1\n' })

    project.write({ '.git/index.lock': '' })

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt'],
      { cwd: folder },
    )

    // Each git version words the advice that follows the first line of its message differently.
    expect(project.normalize(stderr)).toContain(
      cliError(
        "git update-index [1 paths] failed: fatal: Unable to create '<project>/.git/index.lock': File exists.",
      ).trimEnd(),
    )
    expect(exitCode).toBe(1)
    expect(report(stdout).at(-1)).toBe('✔ all checks passed (oxfmt)')
    expect(inIndex(project, `${app}src/extra.ts`)).toBe('export const   extra = 1\n')
  })

  it('stages the fixes of the first commit, which has no HEAD to compare with', async () => {
    const project = create(
      { [`${app}src/extra.ts`]: 'export const   extra = 1\n' },
      { git: 'init' },
    )

    project.git('add', '--all')

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxfmt'],
      { cwd: folder },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout).at(-1)).toBe('✔ staged the fixes to src/extra.ts')
    expect(inIndex(project, `${app}src/extra.ts`)).toBe('export const extra = 1;\n')
    expect(project.git('diff', '--name-only')).toBe('')
  })

  it('keeps the executable mode of a staged file it fixes', async () => {
    const project = create()
    const file = `${app}src/run.ts`

    project.write({ [file]: 'export const   run = 1\n' }).chmod(file, 0o755)
    project.git('add', '--', file)

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/run.ts')
    expect(report(stdout).at(-1)).toBe('✔ staged the fixes to src/run.ts')
    expect(project.git('ls-files', '--stage', '--', file)).toMatch(/^100755 /)
    expect(inIndex(project, file)).toBe('export const run = 1;\n')
    expect(project.mode(file)).toBe(0o755)
    expect(project.git('status', '--porcelain')).toBe(`A  ${file}\n`)
  })

  it('checks regular files only, never a staged symlink or deletion', async () => {
    const project = create({ [`${app}src/gone.ts`]: 'export const gone = 1;\n' })

    project.link(`${app}src/link.ts`, 'index.ts').commit('link')
    project.git('rm', '--quiet', '--', `${app}src/gone.ts`)
    project.write({ [`${app}src/messy.ts`]: 'export const   messy = 1\n' })
    project.link(`${app}src/alias.ts`, 'messy.ts')
    project.git('add', '--', `${app}src/alias.ts`)

    const nothing = await project.uncheck(['staged', '--fix', '--only=oxfmt'], { cwd: folder })

    expect(nothing.exitCode).toBe(0)
    expect(report(nothing.stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '○ oxfmt skipped, only deleted files',
      '○ tsc skipped, not selected by --only',
      '○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt only deleted files, tsc not selected by --only',
    ])

    project.write({ [`${app}src/link.ts`]: null })
    project.stage({ [`${app}src/link.ts`]: 'export const   link = 1\n' })

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout)).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/link.ts')
    expect(report(stdout).at(-1)).toBe('✔ staged the fixes to src/link.ts')
    expect(inIndex(project, `${app}src/link.ts`)).toBe('export const link = 1;\n')
    expect(project.read(`${app}src/messy.ts`)).toBe('export const   messy = 1\n')
    expect(project.git('status', '--porcelain')).toBe(
      `A  ${app}src/alias.ts\nD  ${app}src/gone.ts\nT  ${app}src/link.ts\n?? ${app}src/messy.ts\n`,
    )
  })

  it('leaves staged files under node_modules alone', async () => {
    const dependency = `${app}vendor/node_modules/dep/index.js`
    const project = create().write({
      [dependency]: 'export var   dep = 1\n',
      [`${app}src/extra.ts`]: 'export const   extra = 1\n',
    })

    project.git('add', '--force', '--', dependency, `${app}src/extra.ts`)

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxlint', '--only=oxfmt'],
      { cwd: folder },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint, oxfmt)',
      '✔ staged the fixes to src/extra.ts',
    ])
    expect(inIndex(project, dependency)).toBe('export var   dep = 1\n')
    expect(project.read(dependency)).toBe('export var   dep = 1\n')
  })

  it('fixes and stages exactly the staged files, whatever their names look like', async () => {
    const project = create({ [`${app}routes/i/page.ts`]: 'export const i = 1;\n' })

    project.write({ [`${app}routes/i/page.ts`]: 'export const   i = 2\n' })
    project.stage({
      [`${app}!x.ts`]: 'export const   bang = 1\n',
      [`${app}-x.ts`]: 'export const   dash = 1\n',
      [`${app}routes/[id]/page.ts`]: 'export const   id = 1\n',
    })

    const { exitCode, stdout, stderr } = await project.uncheck(
      ['staged', '--fix', '--only=oxlint', '--only=oxfmt'],
      { cwd: folder, env: { GIT_GLOB_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1' } },
    )

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --fix --no-error-on-unmatched-pattern !x.ts -x.ts routes/[id]/page.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern !x.ts -x.ts routes/[id]/page.ts',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint, oxfmt)',
      '✔ staged the fixes to !x.ts -x.ts routes/[id]/page.ts',
    ])
    expect(inIndex(project, `${app}!x.ts`)).toBe('export const bang = 1;\n')
    expect(inIndex(project, `${app}-x.ts`)).toBe('export const dash = 1;\n')
    expect(inIndex(project, `${app}routes/[id]/page.ts`)).toBe('export const id = 1;\n')
    expect(project.git('status', '--porcelain')).toBe(
      `A  ${app}!x.ts\nA  ${app}-x.ts\nA  ${app}routes/[id]/page.ts\n M ${app}routes/i/page.ts\n`,
    )
  })

  it('never stages the commit a submodule has checked out but not staged', async () => {
    const project = create()
    const submodule = project.path(`${app}vendor`)
    const commit = (message: string) =>
      git(submodule, ['commit', '--quiet', '--allow-empty', `--message=${message}`])

    mkdirSync(submodule)
    git(submodule, ['init', '--quiet'])
    commit('one')
    project.git('add', '--', `${app}vendor`)
    project.commit('submodule')
    commit('two')
    project.git('add', '--', `${app}vendor`)
    project.stage({ [`${app}src/extra.ts`]: 'export const   extra = 1\n' })
    commit('three')

    const before = project.git('rev-parse', `:${app}vendor`)

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=oxfmt'], {
      cwd: folder,
    })

    expect(exitCode).toBe(0)
    expect(report(stdout).at(-1)).toBe('✔ staged the fixes to src/extra.ts')
    expect(project.git('rev-parse', `:${app}vendor`)).toBe(before)
  })
})
