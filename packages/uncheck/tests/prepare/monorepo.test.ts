import { readdirSync } from 'node:fs'

import { createProject } from '../_shared/project'
import { commit, fakeRunner, HEADER, HOOK, runHook } from './helpers'

const APP = '(cd "packages/app" && npx --no uncheck staged --fix --only=oxlint) || exit 1'
const LIB = '(cd "packages/lib" && npx --no uncheck staged --fix) || exit 1'

describe('monorepo', () => {
  it('keeps one line per package, each written from the package folder as its `prepare` script runs', async () => {
    const project = createProject('monorepo', { tools: [] })
    const hook = project.path(HOOK)

    expect((await project.run(['prepare', '--pre-commit'])).stdout).toContain(
      `✔ pre-commit ${HOOK} created\n`,
    )

    const app = await project.run(['prepare', '--pre-commit', '--only=oxlint'], {
      cwd: 'packages/app',
    })

    expect(app.stdout).toContain(`✔ pre-commit ${hook} updated\n`)
    expect(app.stdout).toContain(
      'The hook runs npx --no uncheck staged --fix --only=oxlint before every commit',
    )

    await project.run(['prepare', '--pre-commit'], { cwd: 'packages/lib' })

    expect(project.read(HOOK)).toBe(
      `${HEADER}npx --no uncheck staged --fix || exit 1\n${APP}\n${LIB}\n`,
    )

    // Preparing the top again leaves the lines of the packages alone.
    const top = await project.run(['prepare', '--pre-commit', '--no-fix'])

    expect(top.stdout).toContain(`✔ pre-commit ${HOOK} updated\n`)
    expect(project.read(HOOK)).toBe(`${HEADER}npx --no uncheck staged || exit 1\n${APP}\n${LIB}\n`)

    // As does preparing a package again.
    const lib = await project.run(['prepare', '--pre-commit'], { cwd: 'packages/lib' })

    expect(lib.stdout).toContain(`✔ pre-commit ${hook} unchanged\n`)
  })

  it('writes a hook that runs every line from the top of the working tree, and fails when any line fails', async () => {
    const project = createProject('monorepo', { tools: [] })
    const runner = fakeRunner(project)

    await project.run(['prepare', '--pre-commit'])
    await project.run(['prepare', '--pre-commit', '--only=oxlint'], { cwd: 'packages/app' })
    await project.run(['prepare', '--pre-commit'], { cwd: 'packages/lib' })

    const top = `${project.root} --no uncheck staged --fix`
    const app = `${project.root}/packages/app --no uncheck staged --fix --only=oxlint`
    const lib = `${project.root}/packages/lib --no uncheck staged --fix`

    expect(runHook(project, runner.env)).toBe(0)
    expect(runner.ran()).toEqual([top, app, lib])

    project.write({ fail: '' })

    expect(runHook(project, runner.env)).toBe(1)
    expect(runner.ran()).toEqual([top])

    project.write({ 'fail': null, 'packages/app/fail': '' })

    expect(runHook(project, runner.env)).toBe(1)
    expect(runner.ran()).toEqual([top, app])

    // Through git as well, which runs the hook from the top whatever folder the commit starts in.
    expect(commit(project, 'app fails', runner.env, ['--allow-empty']).status).not.toBe(0)
    expect(runner.ran()).toEqual([top, app])

    project.remove('packages/app/fail')

    expect(commit(project, 'passes', runner.env, ['--allow-empty']).status).toBe(0)
    expect(runner.ran()).toEqual([top, app, lib])
  })

  it('writes hooks that fix and check each package with its own options in a real commit', async () => {
    const project = createProject('monorepo')

    await project.run(['prepare', '--pre-commit'], { cwd: 'packages/app' })
    await project.run(['prepare', '--pre-commit', '--no-fix'], { cwd: 'packages/lib' })

    project.write({ 'packages/app/src/loose.ts': 'export const loose = "text";\n' })
    project.git('add', '-A')

    const fixed = commit(project, 'app')

    expect(fixed.status).toBe(0)
    expect(fixed.output).toContain('uncheck staged in')
    expect(project.git('show', 'HEAD:packages/app/src/loose.ts')).toBe(
      "export const loose = 'text'\n",
    )

    const head = project.git('rev-parse', 'HEAD')

    project.write({ 'packages/lib/src/loose.ts': 'export const loose = "text";\n' })
    project.git('add', '-A')

    const refused = commit(project, 'lib')

    expect(refused.status).not.toBe(0)
    expect(project.git('rev-parse', 'HEAD')).toBe(head)
    expect(project.read('packages/lib/src/loose.ts')).toBe('export const loose = "text";\n')
  })

  it('writes a hook at the top that fixes the files of every package in a real commit', async () => {
    const project = createProject('monorepo')

    expect((await project.run(['prepare', '--pre-commit'])).code).toBe(0)
    expect(project.read(HOOK)).toBe(`${HEADER}npx --no uncheck staged --fix || exit 1\n`)

    project.write({
      'packages/app/src/loose.ts': 'export const loose = "app";\n',
      'packages/lib/src/loose.ts': 'export const loose = "lib";\n',
    })
    project.git('add', '-A')

    expect(commit(project, 'both').status).toBe(0)
    expect(project.git('show', 'HEAD:packages/app/src/loose.ts')).toBe(
      "export const loose = 'app'\n",
    )
    expect(project.git('show', 'HEAD:packages/lib/src/loose.ts')).toBe(
      "export const loose = 'lib'\n",
    )
  })

  it('keeps the line of every package when they all prepare at once, as a workspace install does', async () => {
    const extra = ['c', 'd', 'e', 'f', 'g', 'h']
    const project = createProject('monorepo', {
      tools: [],
      files: Object.fromEntries(
        extra.map((name) => [
          `packages/${name}/package.json`,
          `{\n  "name": "@monorepo/${name}",\n  "version": "1.0.0",\n  "private": true\n}\n`,
        ]),
      ),
    })
    const packages = ['app', 'lib', ...extra]
    const folders = ['.', ...packages.map((name) => `packages/${name}`)]
    const expected = [
      ...HEADER.split('\n'),
      'npx --no uncheck staged --fix || exit 1',
      ...packages.map(
        (name) => `(cd "packages/${name}" && npx --no uncheck staged --fix) || exit 1`,
      ),
    ].sort()

    const results = await Promise.all(
      folders.map((cwd) => project.run(['prepare', '--pre-commit'], { cwd })),
    )

    expect(results.map(({ code }) => code)).toEqual(folders.map(() => 0))
    expect(results.filter(({ stdout }) => stdout.includes(' created\n'))).toHaveLength(1)
    expect(project.read(HOOK).split('\n').sort()).toEqual(expected)
    expect(
      readdirSync(project.path('.git/hooks')).filter((name) => /lock|uncheck/.test(name)),
    ).toEqual([])

    const again = await Promise.all(
      folders.map((cwd) => project.run(['prepare', '--pre-commit'], { cwd })),
    )

    expect(again.every(({ stdout }) => stdout.includes(' unchanged\n'))).toBe(true)
    expect(project.read(HOOK).split('\n').sort()).toEqual(expected)
  })

  it('gives up on a lock another prepare never released and says so, without failing the install', async () => {
    const project = createProject('monorepo', { tools: [] })

    project.write({ [`${HOOK}.lock`]: '' })

    const blocked = await project.run(['prepare', '--pre-commit'], { cwd: 'packages/app' })

    expect(blocked.code).toBe(0)
    expect(blocked.stdout).toMatch(
      new RegExp(`^✘ pre-commit ${project.path(HOOK)} not written, EEXIST.*pre-commit\\.lock`),
    )
    expect(project.exists(HOOK)).toBe(false)
    expect(project.exists(`${HOOK}.lock`)).toBe(true)
  })

  it('updates the lines older versions wrote, whichever package prepares next', async () => {
    const project = createProject('monorepo', { tools: [] })

    project.write({
      [HOOK]: [
        `${HEADER}npx --no uncheck staged --fix`,
        'npm test',
        'cd "packages/app" && npx --no uncheck staged --fix --only=oxlint',
        'cd "packages/lib" && npx --no uncheck staged --fix',
        '',
      ].join('\n'),
    })

    const lib = await project.run(['prepare', '--pre-commit', '--no-fix'], { cwd: 'packages/lib' })

    expect(lib.stdout).toContain(`✔ pre-commit ${project.path(HOOK)} updated\n`)
    expect(project.read(HOOK)).toBe(
      [
        `${HEADER}npx --no uncheck staged --fix || exit 1`,
        'npm test',
        APP,
        '(cd "packages/lib" && npx --no uncheck staged) || exit 1',
        '',
      ].join('\n'),
    )

    const again = await project.run(['prepare', '--pre-commit', '--no-fix'], {
      cwd: 'packages/lib',
    })

    expect(again.stdout).toContain(`✔ pre-commit ${project.path(HOOK)} unchanged\n`)
  })

  it('writes nothing for a package whose folder name sh would misread between double quotes', async () => {
    const names = ['a$b', 'a"b', 'a`b', 'a\\b', 'a\nb']
    const project = createProject('monorepo', {
      tools: [],
      files: Object.fromEntries(names.map((name) => [`packages/${name}/package.json`, '{}\n'])),
    })

    for (const name of names) {
      const refused = await project.run(['prepare', '--pre-commit'], { cwd: `packages/${name}` })

      expect(refused.code).toBe(0)
      expect(refused.stdout).toBe(
        `✘ pre-commit ${project.path(HOOK)} not written, sh would misread the folder name ${JSON.stringify(`packages/${name}`)} between double quotes\n`,
      )
    }

    expect(project.exists(HOOK)).toBe(false)
  })
})
