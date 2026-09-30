import { createProject, eachLayout } from '../_shared/project'
import { at, eachPlace, expectExit, inApp, setup } from './helpers'

eachPlace('$layout at the $at', (place) => {
  it('applies the fixes to the staged files and stages them', async () => {
    const math = inApp(place.layout, 'src/math.ts')
    const { project, shown, staged, index } = setup(place, {
      files: { [math]: 'export function double(value: number): number {\n  return value * 2\n}\n' },
    })

    project.write({
      [math]:
        'var unused = 1\nexport function double(value: number): number {\n  return   value * 2;\n}\n',
      [project.inApp('src/extra.ts')]: "export const   extra = 'x'\n",
    })
    project.git('add', '-A')

    const result = await staged(['--fix'])
    const { stdout } = result
    const files = `${shown('src/extra.ts')} ${shown('src/math.ts')}`

    expectExit(result, 0)
    expect(stdout).toContain(`▶ oxlint --fix --no-error-on-unmatched-pattern ${files}\n`)
    expect(stdout).toContain(`▶ oxfmt --no-error-on-unmatched-pattern ${files}\n`)
    expect(stdout).toContain('✔ all checks passed (oxlint, oxfmt, tsc)\n')
    expect(stdout).toContain(`✔ staged the fixes to ${files}\n`)
    expect(index('src/extra.ts')).toBe("export const extra = 'x'\n")
    expect(index('src/math.ts')).toBe(
      'const unused = 1\nexport function double(value: number): number {\n  return value * 2\n}\n',
    )
    expect(project.git('status', '--porcelain')).toBe(
      `A  ${project.inApp('src/extra.ts')}\nM  ${math}\n`,
    )
  })

  it('stages the fixes even when a check still fails', async () => {
    const { project, shown, staged, index } = setup(place)

    project.write({ [project.inApp('src/extra.ts')]: 'export const   answer: string = 1\n' })
    project.git('add', '-A')

    const result = await staged(['--fix'])
    const { stdout } = result

    expectExit(result, 1)
    expect(stdout).toContain('TS2322')
    expect(stdout).toContain('✘ 1 of 3 checks failed: tsc\n')
    expect(stdout).toContain(`✔ staged the fixes to ${shown('src/extra.ts')}\n`)
    expect(index('src/extra.ts')).toBe('export const answer: string = 1\n')
    expect(project.git('status', '--porcelain')).toBe(`A  ${project.inApp('src/extra.ts')}\n`)
  })

  it('stages nothing when the fixes change nothing', async () => {
    const { project, staged } = setup(place, { tools: ['oxfmt'] })

    project.write({ [project.inApp('src/extra.ts')]: 'export const extra = 1\n' })
    project.git('add', '-A')

    const result = await staged(['--fix', '--only=oxfmt'])
    const { stdout } = result

    expectExit(result, 0)
    expect(stdout).toContain('✔ all checks passed (oxfmt)\n')
    expect(stdout).not.toContain('staged the fixes')
  })

  it('fails when the fixes undo every staged change, unless empty commits are allowed', async () => {
    const math = inApp(place.layout, 'src/math.ts')
    const { project, shown, staged } = setup(place, {
      tools: ['oxfmt'],
      files: { [math]: 'export function double(value: number): number {\n  return value * 2\n}\n' },
    })

    // Only formatting differs from what is committed, and an unstaged line waits on top of it.
    project.write({
      [math]: 'export function double(value: number): number {\n  return   value * 2;\n}\n',
    })
    project.git('add', '-A')
    project.write({
      [math]:
        'export function double(value: number): number {\n  return   value * 2;\n}\nexport const more = 1\n',
    })

    const empty = await staged(['--fix', '--only=oxfmt'])

    expectExit(empty, 1)
    expect(empty.stderr).toContain(
      'The fixes undid every staged change, so the commit would be empty. To allow empty commits, pass --allow-empty to `uncheck staged`, or to `uncheck prepare` for the hook it writes.',
    )
    expect(project.git('diff', '--cached', '--name-only')).toBe('')
    expect(project.read(math)).toBe(
      'export function double(value: number): number {\n  return value * 2\n}\nexport const more = 1\n',
    )
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)

    project.write({ [project.inApp('src/extra.ts')]: 'export const extra = 1\n' })
    project.git('add', '-A')
    project.git('commit', '--quiet', '-m', 'extra')
    project.write({ [project.inApp('src/extra.ts')]: 'export const   extra   = 1\n' })
    project.git('add', '-A')

    const allowed = await staged(['--fix', '--only=oxfmt', '--allow-empty'])

    expectExit(allowed, 0)
    expect(allowed.stdout).toContain(`✔ staged the fixes to ${shown('src/extra.ts')}\n`)
    expect(project.git('diff', '--cached', '--name-only')).toBe('')
  })
})

eachLayout('$layout', ({ layout }) => {
  it('stages the fixes of the first commit of a repository', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      git: false,
      files: { [inApp(layout, 'src/math.ts')]: 'export const   two = 2\n' },
    })

    project.git('init', '--quiet')
    project.git('add', '-A')

    const { staged, index } = at(project, project.appDir)
    const result = await staged(['--fix', '--only=oxfmt'])
    const { stdout } = result

    expectExit(result, 0)
    expect(stdout).toContain('✔ staged the fixes to src/math.ts\n')
    expect(index('src/math.ts')).toBe('export const two = 2\n')
  })

  it('checks and fixes staged files whose names start with ! or -', async () => {
    const project = createProject(layout, { tools: ['oxlint', 'oxfmt'] })
    const { staged, index } = at(project, project.appDir)

    project.write({
      [project.inApp('!bang.ts')]: 'export const   bang = 1\n',
      [project.inApp('-dash.ts')]: 'var dash = 1\nexport { dash }\n',
      [project.inApp('plain.ts')]: 'export const   plain = 1\n',
    })
    project.git('add', '-A')

    const result = await staged(['--fix', '--only=oxlint', '--only=oxfmt'])
    const { stdout } = result

    expectExit(result, 0)
    expect(stdout).toContain('▶ oxfmt --no-error-on-unmatched-pattern !bang.ts -dash.ts plain.ts\n')
    expect(stdout).toContain('✔ all checks passed (oxlint, oxfmt)\n')
    expect(stdout).toContain('✔ staged the fixes to !bang.ts -dash.ts plain.ts\n')
    expect(index('!bang.ts')).toBe('export const bang = 1\n')
    expect(index('-dash.ts')).toBe('const dash = 1\nexport { dash }\n')
    expect(index('plain.ts')).toBe('export const plain = 1\n')
  })

  it('stages only the staged files, even when their names look like patterns', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: {
        [inApp(layout, 'app/[id]/page.ts')]: 'export const id = 1\n',
        [inApp(layout, 'app/i/page.ts')]: 'export const i = 1\n',
      },
    })
    const { staged } = at(project, project.appDir)

    project.write({
      [project.inApp('app/[id]/page.ts')]: 'export const   id = 2\n',
      [project.inApp('app/i/page.ts')]: 'export const   i = 2\n',
    })
    project.git('--literal-pathspecs', 'add', project.inApp('app/[id]/page.ts'))

    const result = await staged(['--fix', '--only=oxfmt'], {
      env: { GIT_GLOB_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1' },
    })

    expectExit(result, 0)
    expect(project.git('status', '--porcelain')).toBe(
      `M  ${project.inApp('app/[id]/page.ts')}\n M ${project.inApp('app/i/page.ts')}\n`,
    )
    expect(project.git('show', `:${project.inApp('app/[id]/page.ts')}`)).toBe(
      'export const id = 2\n',
    )
  })

  it('checks, fixes and sets aside more files than one command line holds', async () => {
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged, index } = at(project, project.appDir)
    // 700 names of about 100 characters are more than the 30,000 characters a batch of arguments takes.
    const names = Array.from(
      { length: 700 },
      (_, index) => `src/many/${'m'.repeat(90)}${String(index).padStart(3, '0')}.ts`,
    )

    project.write(
      Object.fromEntries(names.map((name) => [project.inApp(name), 'export const a = 1\n'])),
    )
    project.commit('many')
    project.write(
      Object.fromEntries(
        names.map((name) => [project.inApp(name), 'export const   a = 2\nexport const b = 1\n']),
      ),
    )
    project.git('add', '-A')
    project.write(
      Object.fromEntries(
        names.map((name) => [
          project.inApp(name),
          'export const   a = 2\nexport const b = 1\nexport const c = 1\n',
        ]),
      ),
    )

    const result = await staged(['--fix', '--only=oxfmt'])
    const { stdout } = result

    expectExit(result, 0)
    expect(stdout).toContain(
      '○ unstaged changes of [700 files] set aside until the checks finish\n',
    )
    expect(stdout).toContain(
      '✔ staged the fixes to [700 files]\n○ unstaged changes of [700 files] restored\n',
    )
    expect(stdout.match(/▶ oxfmt/g)!.length).toBeGreaterThan(1)
    expect(index(names[0]!)).toBe('export const a = 2\nexport const b = 1\n')
    expect(index(names[699]!)).toBe('export const a = 2\nexport const b = 1\n')
    expect(project.read(project.inApp(names[699]!))).toBe(
      'export const a = 2\nexport const b = 1\nexport const c = 1\n',
    )
    expect(project.git('status', '--porcelain').split('\n')[0]).toBe(
      `MM ${project.inApp(names[0]!)}`,
    )
  })
})
