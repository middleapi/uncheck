import { chmodSync, statSync } from 'node:fs'
import process from 'node:process'

import { createProject, eachLayout } from '../_shared/project'
import { at, eachPlace, expectExit, fakeTool, inApp, setup } from './helpers'

eachPlace('$layout at the $at', (place) => {
  it('sets unstaged changes aside while the checks run and puts them back over the fixes', async () => {
    const body = 'export function double(value: number): number {\n  return value * 2\n}\n'
    const math = inApp(place.layout, 'src/math.ts')
    const { project, cwd, shown, staged, index } = setup(place, {
      tools: ['oxlint', 'oxfmt'],
      files: { [math]: body },
    })

    project.write({ [math]: `export const   two = 2;\n${body}` })
    project.git('add', '-A')
    // An unstaged hunk in the staged file, an unstaged file and an untracked one: none of them is checked.
    project.write({
      [math]: `export const   two = 2;\n${body}export const three = 3\n`,
      [project.inApp('src/index.ts')]: 'export const   other = 3\n',
      [project.inApp('src/fresh.ts')]: 'var fresh = 4\n',
    })

    const result = await staged(['--fix', '--only=oxlint', '--only=oxfmt'])
    const file = shown('src/math.ts')

    expectExit(result, 0)
    expect(result.stdout).toContain(
      `uncheck staged in ${project.path(cwd)}\n○ unstaged changes of ${file} set aside until the checks finish\n`,
    )
    expect(result.stdout).toContain(`▶ oxlint --fix --no-error-on-unmatched-pattern ${file}\n`)
    expect(result.stdout).toContain(
      `✔ staged the fixes to ${file}\n○ unstaged changes of ${file} restored\n`,
    )
    expect(index('src/math.ts')).toBe(`export const two = 2\n${body}`)
    expect(project.read(math)).toBe(`export const two = 2\n${body}export const three = 3\n`)
    expect(project.read(project.inApp('src/index.ts'))).toBe('export const   other = 3\n')
    expect(project.read(project.inApp('src/fresh.ts'))).toBe('var fresh = 4\n')
    expect(project.git('status', '--porcelain')).toBe(
      ` M ${project.inApp('src/index.ts')}\nMM ${math}\n?? ${project.inApp('src/fresh.ts')}\n`,
    )
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('undoes every fix when one conflicts with unstaged changes, so nothing is lost', async () => {
    const far = Array.from({ length: 30 }, (_, index) => `export const f${index} = ${index}\n`)
    const { project, shown, staged, index } = setup(place, {
      tools: ['oxfmt'],
      files: { [inApp(place.layout, 'src/far.ts')]: far.join('') },
    })
    const [extra, other, farFile] = ['src/extra.ts', 'src/other.ts', 'src/far.ts'].map((file) =>
      project.inApp(file),
    ) as [string, string, string]
    const farStaged = ['export const f0   =   0\n', ...far.slice(1)].join('')
    const farUnstaged = [
      'export const f0   =   0\n',
      ...far.slice(1, -1),
      'export const f29 = 30\n',
    ]

    // git's own checkout would run this hook, which fails.
    project.write({
      '.git/hooks/post-checkout': '#!/bin/sh\ntouch .git/post-checkout-ran\nexit 1\n',
    })
    chmodSync(project.path('.git/hooks/post-checkout'), 0o755)
    // The unstaged change touches the line the formatter rewrites.
    project.write({ [extra]: 'export const   extra = 1\n', [other]: 'export const   other = 2\n' })
    project.write({ [farFile]: farStaged })
    project.git('add', '-A')
    project.write({ [extra]: 'export const   extra = 2\n', [farFile]: farUnstaged.join('') })

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 1)
    expect(result.stdout).toContain(`✔ staged the fixes to `)
    expect(result.stdout).not.toContain('restored')
    expect(result.stderr).toContain(
      `The fixes conflict with the unstaged changes of ${shown('src/extra.ts')} and were undone. Stage the whole file, or stash its unstaged changes, then commit again.`,
    )
    expect(index('src/extra.ts')).toBe('export const   extra = 1\n')
    expect(project.read(extra)).toBe('export const   extra = 2\n')
    // The fixes to the other staged files are undone too, so a commit attempt never half applies.
    expect(index('src/other.ts')).toBe('export const   other = 2\n')
    expect(project.read(other)).toBe('export const   other = 2\n')
    expect(index('src/far.ts')).toBe(farStaged)
    expect(project.read(farFile)).toBe(farUnstaged.join(''))
    expect(project.exists('.git/post-checkout-ran')).toBe(false)
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })
})

eachLayout('$layout', ({ layout }) => {
  const files = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).map(([file, content]) => [
        layout === 'single' ? file : `packages/app/${file}`,
        content,
      ]),
    )

  it('puts unstaged lines back where they were after the fixes move or change lines around them', async () => {
    const split = 'export const list = [\n  1,\n  2,\n];\n'
    const joined = 'export const list = [1, 2]\n'
    const body =
      '\nexport function f() {\n  return 1\n}\n\nexport function g() {\n  return "g";\n}\n'
    const fixed = body.replace('"g";', "'g'")
    const edit = (text: string) =>
      `${text.replace('  return 1\n', '  // in f\n  return 1\n')}\nexport const z = 1\n`
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: files({ 'src/list.ts': joined }),
    })
    const { staged, index } = at(project, project.appDir)
    const file = project.inApp('src/list.ts')

    project.write({ [file]: split + body })
    project.git('add', '-A')
    project.write({ [file]: split + edit(body) })

    expectExit(await staged(['--fix', '--only=oxfmt']), 0)
    expect(index('src/list.ts')).toBe(joined + fixed)
    expect(project.read(file)).toBe(joined + edit(fixed))
  })

  it('merges by plain text whatever merge driver the repository sets', async () => {
    const lines = 'export const a = 1\nexport const b = 2\nexport const c = 3\n'
    const project = createProject(layout, { tools: ['oxfmt'] })
    const { staged, index } = at(project, project.appDir)
    const file = project.inApp('src/lines.ts')

    project.write({ '.git/info/attributes': '*.ts merge=ours\n' })
    project.git('config', 'merge.ours.driver', 'true')
    project.write({ [file]: `export const   answer = 42\n${lines}` })
    project.git('add', '-A')
    project.write({ [file]: `export const   answer = 42\n${lines.replace('c = 3', 'c = 30')}` })

    expectExit(await staged(['--fix', '--only=oxfmt']), 0)
    expect(index('src/lines.ts')).toBe(`export const answer = 42\n${lines}`)
    expect(project.read(file)).toBe(`export const answer = 42\n${lines.replace('c = 3', 'c = 30')}`)
  })

  it('reads every unstaged change right, a rename and an intent to add among them', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: files({ 'src/aaa.ts': 'export const aaa = 1\n' }),
    })
    const { staged, index } = at(project, project.appDir)
    const other = project.inApp('src/other.ts')

    project.write({ [other]: 'export const other = 3\n' })
    project.git('add', other)
    project.write({ [other]: 'export const other = 3\nexport const more = 4\n' })
    project.git('mv', project.inApp('src/aaa.ts'), project.inApp('src/moved.ts'))
    project.git(
      'reset',
      '--quiet',
      '--',
      project.inApp('src/aaa.ts'),
      project.inApp('src/moved.ts'),
    )
    project.git('add', '--intent-to-add', project.inApp('src/moved.ts'))

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 0)
    expect(result.stdout).toContain('○ unstaged changes of src/other.ts restored\n')
    expect(index('src/other.ts')).toBe('export const other = 3\n')
    expect(project.read(other)).toBe('export const other = 3\nexport const more = 4\n')
  })

  it('refuses to set aside an unstaged change that is not an edit to a file', async () => {
    const project = createProject(layout, { tools: [] })
    const { staged, index } = at(project, project.appDir)
    const other = project.inApp('src/other.ts')

    project.write({ [other]: 'export const other = 3\n' })
    project.git('add', other)
    project.remove(other)

    const result = await staged(['--fix'])

    expectExit(result, 1)
    expect(result.stderr).toContain(
      'The unstaged changes of src/other.ts are not edits to a file and cannot be set aside. Stage or stash them, then commit again.',
    )
    expect(project.exists(other)).toBe(false)
    expect(index('src/other.ts')).toBe('export const other = 3\n')
  })

  it.skipIf(process.platform === 'win32')(
    'keeps an unstaged change of the executable bit over the fixes',
    async () => {
      const project = createProject(layout, { tools: ['oxfmt'] })
      const { staged, index } = at(project, project.appDir)
      const file = project.inApp('src/run.ts')

      project.write({ [file]: 'export const   run = 1\n' })
      project.git('add', file)
      chmodSync(project.path(file), 0o755)

      const result = await staged(['--fix', '--only=oxfmt'])

      expectExit(result, 0)
      expect(result.stdout).toContain('○ unstaged changes of src/run.ts restored\n')
      expect(index('src/run.ts')).toBe('export const run = 1\n')
      expect(project.read(file)).toBe('export const run = 1\n')
      expect(statSync(project.path(file)).mode & 0o777).toBe(0o755)
      expect(project.git('status', '--porcelain')).toBe(`AM ${file}\n`)
    },
  )

  it('keeps an edit saved to a partially staged file while the checks run', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `export const v${index} = ${index}\n`)
    const file = layout === 'single' ? 'src/lines.ts' : 'packages/app/src/lines.ts'
    // An editor saving the file halfway through the checks.
    const project = createProject(layout, {
      tools: [],
      files: {
        [file]: lines.join(''),
        ...fakeTool(
          'oxlint',
          "const fs = require('node:fs')\nfs.writeFileSync('src/lines.ts', fs.readFileSync('src/lines.ts', 'utf8').replace('v15 = 15', 'v15 = 1500'))\n",
        ),
      },
    })
    const { staged, index } = at(project, project.appDir)
    const inStage = ['export const v0 = 100\n', ...lines.slice(1)]

    project.write({ [file]: inStage.join('') })
    project.git('add', file)
    project.write({ [file]: [...inStage.slice(0, -1), 'export const v29 = 2900\n'].join('') })

    expectExit(await staged(['--only=oxlint']), 0)
    expect(project.read(file)).toBe(
      [
        ...inStage.slice(0, 15),
        'export const v15 = 1500\n',
        ...inStage.slice(16, -1),
        'export const v29 = 2900\n',
      ].join(''),
    )
    expect(index('src/lines.ts')).toBe(inStage.join(''))
  })
})

describe('monorepo', () => {
  it.skipIf(process.platform === 'win32')(
    'puts unstaged changes back from a package whose folder name has a newline',
    async () => {
      const dir = 'packages/new\nline'
      const rest = 'export const b = 1\nexport const c = 1\nexport const d = 1\nexport const e ='
      const project = createProject('monorepo', {
        tools: ['oxfmt'],
        files: { [`${dir}/src/index.ts`]: `export const a = 1\n${rest} 1\n` },
      })
      const { staged } = at(project, dir)
      const file = `${dir}/src/index.ts`

      project.write({ [file]: `export const   a = 2\n${rest} 1\n` })
      project.git('add', '-A')
      project.write({ [file]: `export const   a = 2\n${rest} 2\n` })

      const result = await staged(['--fix', '--only=oxfmt'])

      expectExit(result, 0)
      expect(result.stdout).toContain('○ unstaged changes of src/index.ts restored\n')
      expect(project.git('show', `:${file}`)).toBe(`export const a = 2\n${rest} 1\n`)
      expect(project.read(file)).toBe(`export const a = 2\n${rest} 2\n`)
    },
  )
})
