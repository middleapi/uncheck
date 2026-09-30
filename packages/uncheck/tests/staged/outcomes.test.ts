import { once } from 'node:events'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

import { createProject, eachLayout } from '../_shared/project'
import { at, expectExit, fakeTool, inApp, startUncheck } from './helpers'

eachLayout('$layout', ({ layout }) => {
  const rest = 'export const b = 1\nexport const c = 1\nexport const d = 1\nexport const e ='

  it('keeps the unstaged changes when setting them aside fails halfway', async () => {
    const project = createProject(layout, { tools: [] })
    const { staged } = at(project, project.appDir)
    const [one, two] = [project.inApp('src/one.ts'), project.inApp('src/two.ts')]

    project.write({ '.git/info/attributes': '*.ts filter=flaky\n' })
    project.git('config', 'filter.flaky.clean', 'cat')
    project.git(
      'config',
      'filter.flaky.smudge',
      'if [ -e .git/failed ]; then cat; else touch .git/failed; exit 1; fi',
    )
    project.git('config', 'filter.flaky.required', 'true')
    project.write({ [one]: 'export const one = 1\n', [two]: 'export const two = 1\n' })
    project.git('add', '-A')
    project.write({ [one]: 'export const one = 2\n', [two]: 'export const two = 2\n' })

    const result = await staged()

    expectExit(result, 1)
    expect(result.stderr).toContain('git checkout-index -f [2 paths] failed')
    expect(project.read(one)).toBe('export const one = 2\n')
    expect(project.read(two)).toBe('export const two = 2\n')
    expect(project.git('status', '--porcelain')).toBe(`AM ${one}\nAM ${two}\n`)
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('keeps the unstaged changes aside and stops the commit when git cannot put them back', async () => {
    const file = inApp(layout, 'src/five.ts')
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: { [file]: `export const a = 1\n${rest} 1\n` },
    })
    const { staged, index } = at(project, project.appDir)

    project.write({ '.git/info/attributes': '*.ts filter=once\n' })
    project.git('config', 'filter.once.clean', 'cat')
    project.git(
      'config',
      'filter.once.smudge',
      'if [ -e .git/smudged ]; then exit 1; else touch .git/smudged; cat; fi',
    )
    project.git('config', 'filter.once.required', 'true')
    project.write({ [file]: `export const   a = 2\n${rest} 1\n` })
    project.git('add', file)
    project.write({ [file]: `export const   a = 2\n${rest} 2\n` })

    const result = await staged(['--fix', '--only=oxfmt'])

    expectExit(result, 1)
    expect(result.stdout).toMatch(
      /✘ could not put back the unstaged changes of src\/five\.ts: git cat-file --filters --path=\S+ \w+ failed: /,
    )
    expect(result.stdout).toContain(
      `  their unstaged versions are in ${project.path('.git/uncheck-unstaged')}, at their paths from the top of the repository: copy back what your files are missing and delete the folder\n`,
    )
    expect(result.stderr).toContain(
      'The unstaged changes of src/five.ts could not be put back, see above.',
    )
    expect(index('src/five.ts')).toBe(`export const a = 2\n${rest} 1\n`)
    expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe(`export const   a = 2\n${rest} 2\n`)

    // The next run stops rather than overwrite that only copy.
    const next = await staged(['--fix', '--only=oxfmt'])

    expectExit(next, 1)
    expect(next.stderr).toContain(
      `An earlier run left the unstaged versions of your files in ${project.path('.git/uncheck-unstaged')}, at their paths from the top of the repository. Unless another commit is running, copy back what your files are missing, delete the folder, then commit again.`,
    )
  })

  it('reports what it could not put back when the saved copy is gone', async () => {
    const file = inApp(layout, 'src/gone.ts')
    // A tool that deletes the copy uncheck set aside, and changes nothing else.
    const project = createProject(layout, {
      tools: [],
      files: {
        [file]: 'export const gone = 1\n',
        ...fakeTool(
          'oxlint',
          `const { execSync } = require('node:child_process')\nconst top = execSync('git rev-parse --show-toplevel').toString().trim()\nrequire('node:fs').rmSync(top + '/.git/uncheck-unstaged/${file}')\n`,
        ),
      },
    })
    const { staged } = at(project, project.appDir)

    project.write({ [file]: 'export const gone = 2\n' })
    project.git('add', file)
    project.write({ [file]: 'export const gone = 3\n' })

    const result = await staged(['--only=oxlint'])

    expectExit(result, 1)
    expect(result.stdout).toContain('✘ could not put back the unstaged changes of src/gone.ts: ')
    expect(result.stdout).toContain('NotFound')
    expect(result.stderr).toContain('The unstaged changes of src/gone.ts could not be put back')
    expect(project.exists('.git/uncheck-unstaged')).toBe(true)
  })

  it('reports what it could not put back when git cannot merge the file', async () => {
    const file = inApp(layout, 'src/data.ts')
    // Content git takes for binary, which merge-file refuses, and a tool that edits it.
    const project = createProject(layout, {
      tools: [],
      files: {
        [file]: 'export const data = "\0"\n',
        ...fakeTool(
          'oxlint',
          "require('node:fs').appendFileSync('src/data.ts', 'export const more = 1\\n')\n",
        ),
      },
    })
    const { staged } = at(project, project.appDir)

    project.write({ [file]: 'export const data = "\0\0"\n' })
    project.git('add', file)
    project.write({ [file]: 'export const data = "\0\0\0"\n' })

    const result = await staged(['--only=oxlint'])

    expectExit(result, 1)
    expect(result.stdout).toMatch(
      /✘ could not put back the unstaged changes of src\/data\.ts: git merge-file --quiet \S+ \S+ \S+ failed: \n/,
    )
    expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe('export const data = "\0\0\0"\n')
  })

  it('stops instead of overwriting unstaged changes an earlier run left behind', async () => {
    const project = createProject(layout, { tools: [] })
    const { staged } = at(project, project.appDir)
    const file = project.inApp('src/left.ts')

    project.write({ [file]: 'export const left = 1\n' })
    project.git('add', file)
    project.write({
      [file]: 'export const left = 2\n',
      [`.git/uncheck-unstaged/${file}`]: 'left behind',
    })

    const result = await staged(['--fix'])

    expectExit(result, 1)
    expect(result.stderr).toMatch(/An earlier run left the unstaged versions of your files in /)
    expect(project.read(`.git/uncheck-unstaged/${file}`)).toBe('left behind')
    expect(project.read(file)).toBe('export const left = 2\n')
  })

  it.skipIf(process.platform === 'win32')(
    'stops when another run claims the folder for unstaged changes first',
    async () => {
      const project = createProject(layout, { tools: [] })
      const { staged } = at(project, project.appDir)
      const file = project.inApp('src/race.ts')

      project.write({ [file]: 'export const race = 1\n' })
      project.git('add', file)
      project.write({ [file]: 'export const race = 2\n' })
      // Nothing is there to find, yet creating the folder fails as if a parallel run just had.
      symlinkSync(project.path('.git/missing'), project.path('.git/uncheck-unstaged'))

      const result = await staged()

      expectExit(result, 1)
      expect(result.stderr).toMatch(/An earlier run left the unstaged versions of your files in /)
      expect(project.read(file)).toBe('export const race = 2\n')
    },
  )

  it.runIf(process.platform === 'linux')(
    'keeps the unstaged changes when it cannot copy them aside',
    async () => {
      const project = createProject(layout, { tools: [] })
      const { staged } = at(project, project.appDir)
      // A path that fits the system limit where it is, but not below .git/uncheck-unstaged.
      const start = project.inApp('src/')
      let deep = ''

      while (project.root.length + 1 + start.length + deep.length + 200 < 4090) {
        deep += `${'d'.repeat(199)}/`
      }

      const file = `${start}${deep}${'f'.repeat(4085 - project.root.length - 1 - start.length - deep.length - 3)}.ts`

      mkdirSync(dirname(project.path(file)), { recursive: true })
      writeFileSync(project.path(file), 'export const long = 1\n')
      project.git('add', file)
      writeFileSync(project.path(file), 'export const long = 2\n')

      const result = await staged()

      expectExit(result, 1)
      expect(result.stderr).toContain(`FileSystem.copyFile (${project.path(file)})`)
      expect(project.read(file)).toBe('export const long = 2\n')
      expect(project.git('show', `:${file}`)).toBe('export const long = 1\n')
      expect(project.exists('.git/uncheck-unstaged')).toBe(false)
    },
  )

  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    it.skipIf(process.platform === 'win32')(
      `puts unstaged changes back when ${signal} stops a slow check`,
      async () => {
        const file = inApp(layout, 'src/slow.ts')
        // A tool that says when it started, then runs until it is stopped.
        const project = createProject(layout, {
          tools: [],
          files: {
            [file]: 'export const slow = 1\n',
            ...fakeTool(
              'oxlint',
              "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'started'), '')\nsetTimeout(() => {}, 20_000)\n",
            ),
          },
        })

        project.write({ [file]: 'export const slow = 2\n' })
        project.git('add', file)
        project.write({ [file]: 'export const slow = 2\nexport const more = 1\n' })

        const child = startUncheck(project, ['staged', '--only=oxlint'], project.appDir)
        const exited = once(child, 'exit')

        await vi.waitFor(() => expect(project.exists('node_modules/oxlint/started')).toBe(true), {
          timeout: 15_000,
        })
        // A closed terminal hangs up twice: the shell forwards it, then the kernel sends it.
        child.kill(signal)

        if (signal === 'SIGHUP') {
          child.kill(signal)
        }

        expect(await exited).toEqual([130, null])
        expect(project.read(file)).toBe('export const slow = 2\nexport const more = 1\n')
        expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
        expect(project.exists('.git/uncheck-unstaged')).toBe(false)
      },
    )
  }
})
