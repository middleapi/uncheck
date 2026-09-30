import { createProject, eachLayout } from '../_shared/project'
import { at, eachPlace, setup } from './helpers'

eachPlace('$layout at the $at', (place) => {
  it('checks only the staged files and reports without touching them', async () => {
    const { project, cwd, shown, staged, index } = setup(place)

    project.write({ [project.inApp('src/math.ts')]: 'export const   answer: string = 1\n' })
    project.git('add', '-A')
    // An unstaged file, an untracked one and a staged file outside the package: none of them is checked.
    project.write({
      [project.inApp('src/index.ts')]: 'export const   unstaged = 1\n',
      [project.inApp('src/fresh.ts')]: 'var fresh = 1\n',
    })

    const { code, stdout, stderr } = await staged()
    const tsconfig = shown('tsconfig.json')

    expect(code).toBe(1)
    expect(stderr).toBe('')
    expect(stdout).toContain(`uncheck staged in ${project.path(cwd)}\n`)
    expect(stdout).toContain('○ sherif skipped, no package.json among the given files\n')
    expect(stdout).toContain(`▶ oxlint --no-error-on-unmatched-pattern ${shown('src/math.ts')}\n`)
    expect(stdout).toContain(
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${shown('src/math.ts')}\n`,
    )
    expect(stdout).toContain(`▶ tsc -p ${tsconfig} --noEmit\n`)
    expect(stdout).toContain('TS2322')
    expect(stdout).toContain('✘ 2 of 3 checks failed: oxfmt, tsc\n')
    expect(stdout).toContain('  rerun with `--fix` to apply oxfmt fixes\n')
    expect(stdout).not.toContain('staged the fixes')
    expect(index('src/math.ts')).toBe('export const   answer: string = 1\n')
    expect(project.read(project.inApp('src/index.ts'))).toBe('export const   unstaged = 1\n')
  })

  it('passes when nothing is staged', async () => {
    const { project, cwd, staged } = setup(place, { tools: [] })

    project.write({ [project.inApp('src/index.ts')]: 'export const   unstaged = 1\n' })

    const { code, stdout } = await staged(['--fix'])

    expect(code).toBe(0)
    expect(stdout).toBe(
      `uncheck staged in ${project.path(cwd)}\n○ nothing to check, no staged files\n`,
    )
  })

  it('passes a commit no check has anything to do with, unless a check is required', async () => {
    const { project, staged } = setup(place, { tools: ['typescript'] })

    project.write({ [project.inApp('README.md')]: '# app\n' })
    project.git('add', '-A')

    const docs = await staged(['--only=tsc'])

    expect(docs.code).toBe(0)
    expect(docs.stdout).toContain(
      '○ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc no tsconfig.json covers the given files\n',
    )

    const required = await staged(['--only=tsc', '--require=tsc'])

    expect(required.code).toBe(1)
    expect(required.stdout).toContain('✘ tsc no tsconfig.json covers the given files\n')
    expect(required.stdout).toContain('✘ 1 of 1 checks failed: tsc\n')
  })
})

eachLayout('$layout', ({ layout }) => {
  it('needs a git repository', async () => {
    const project = createProject(layout, { git: false, tools: [] })
    const { code, stdout, stderr } = await project.run(['staged'], { cwd: project.appDir })

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('`uncheck staged` needs a git repository')
  })

  it('refuses a selection that contradicts itself before it looks at git', async () => {
    const project = createProject(layout, { git: false, tools: [] })
    const { code, stderr } = await project.run(['staged', '--require=tsc', '--skip=tsc'])

    expect(code).toBe(1)
    expect(stderr).toContain('--require=tsc and --skip=tsc contradict each other.')
  })

  it('runs where --cwd points, as a hook line for a package can', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })

    project.write({ [project.inApp('src/math.ts')]: 'export const   two = 2\n' })
    project.git('add', '-A')

    const { code, stdout } = await project.run([
      'staged',
      '--fix',
      '--only=oxfmt',
      `--cwd=${project.app}`,
    ])

    expect(code).toBe(0)
    expect(stdout).toContain(`uncheck staged in ${project.app}\n`)
    expect(stdout).toContain('✔ staged the fixes to src/math.ts\n')
    expect(project.git('show', `:${project.inApp('src/math.ts')}`)).toBe('export const two = 2\n')
  })

  it('reports git failing when the folder is inside the repository but not its work tree', async () => {
    const project = createProject(layout, { tools: [] })

    project.write({ [project.inApp('src/math.ts')]: 'export const two = 2\n' })
    project.git('add', '-A')

    const { code, stderr } = await project.run(['staged'], { cwd: '.git' })

    expect(code).toBe(1)
    expect(stderr).toMatch(/git rev-parse --is-inside-work-tree .* failed: not inside a work tree/)
  })
})

describe('monorepo', () => {
  it('checks and fixes only the staged files of the package it runs in', async () => {
    const project = createProject('monorepo')
    const { staged, index } = at(project, 'packages/app')

    project.write({
      'packages/app/src/extra.ts': 'export const   extra = 1\n',
      'packages/lib/src/index.ts': 'export const   lib = 1\n',
    })
    project.git('add', '-A')

    const { code, stdout } = await staged(['--fix'])

    expect(code).toBe(0)
    expect(stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts\n')
    expect(stdout).toContain('✔ staged the fixes to src/extra.ts\n')
    expect(index('src/extra.ts')).toBe('export const extra = 1\n')
    expect(project.git('show', ':packages/lib/src/index.ts')).toBe('export const   lib = 1\n')
  })

  it('only reports what sherif finds, since its fixes reach beyond the staged files', async () => {
    const project = createProject('monorepo', { tools: ['sherif'] })
    const manifest = (name: string, react: string) =>
      `{\n  "name": "@monorepo/${name}",\n  "version": "1.0.0",\n  "private": true,\n  "type": "module",\n  "dependencies": {\n    "react": "${react}"\n  }\n}\n`

    project.write({
      'packages/app/package.json': manifest('app', '^18.0.0'),
      'packages/lib/package.json': manifest('lib', '^17.0.0'),
    })
    project.git('add', '-A')

    const { code, stdout } = await project.run(['staged', '--fix'])

    expect(code).toBe(1)
    expect(stdout).toContain('▶ sherif\n')
    expect(stdout).toContain('✘ 1 of 1 checks failed: sherif\n')
    expect(stdout).not.toContain('rerun with')
    expect(stdout).not.toContain('staged the fixes')
    expect(project.git('status', '--porcelain')).toBe(
      'M  packages/app/package.json\nM  packages/lib/package.json\n',
    )
  })
})
