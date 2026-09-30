import { chmodSync, statSync } from 'node:fs'

import { createProject, eachLayout } from '../_shared/project'
import { commit, HEADER, HOOK, shownFrom } from './helpers'

eachLayout('$layout', ({ layout }) => {
  /** The hook line of the package, as the monorepo enters its folder first. */
  const lineOf = (command: string) =>
    layout === 'single' ? `${command} || exit 1` : `(cd "packages/app" && ${command}) || exit 1`

  it('asks for --pre-commit and writes nothing without it', async () => {
    const project = createProject(layout, { tools: [] })

    const result = await project.run(['prepare'], { cwd: project.appDir })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      'Nothing to prepare. Pass --pre-commit to write the git hook that runs `uncheck staged --fix` before every commit.',
    )
    expect(project.exists(HOOK)).toBe(false)
  })

  it('writes the hook, leaves it as it is when nothing changed and updates it with the options', async () => {
    const project = createProject(layout, { tools: [] })
    const cwd = project.appDir
    const shown = shownFrom(project, cwd)
    const prepare = (...args: string[]) =>
      project.run(['prepare', '--pre-commit', ...args], { cwd })

    const created = await prepare()

    expect(created).toMatchObject({ code: 0, stderr: '' })
    expect(created.stdout).toBe(
      `✔ pre-commit ${shown} created\n\nThe hook runs npx --no uncheck staged --fix before every commit, \`git commit --no-verify\` skips it.\n`,
    )
    expect(project.read(HOOK)).toBe(`${HEADER}${lineOf('npx --no uncheck staged --fix')}\n`)
    expect(statSync(project.path(HOOK)).mode & 0o777).toBe(0o755)

    // An unchanged hook is made executable again, since git skips a hook it cannot run.
    chmodSync(project.path(HOOK), 0o644)

    const again = await prepare()

    expect(again.code).toBe(0)
    expect(again.stdout).toContain(`✔ pre-commit ${shown} unchanged\n`)
    expect(statSync(project.path(HOOK)).mode & 0o777).toBe(0o755)

    const selected = await prepare('--only=oxlint', '--only=oxfmt')

    expect(selected.stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    expect(selected.stdout).toContain(
      'The hook runs npx --no uncheck staged --fix --only=oxlint --only=oxfmt before every commit',
    )
    expect(project.read(HOOK)).toBe(
      `${HEADER}${lineOf('npx --no uncheck staged --fix --only=oxlint --only=oxfmt')}\n`,
    )

    await prepare('--allow-empty', '--require=tsc', '--skip=sherif')

    expect(project.read(HOOK)).toBe(
      `${HEADER}${lineOf('npx --no uncheck staged --fix --allow-empty --require=tsc --skip=sherif')}\n`,
    )

    const checkOnly = await prepare('--no-fix')

    expect(checkOnly.stdout).toContain('The hook runs npx --no uncheck staged before every commit')
    expect(project.read(HOOK)).toBe(`${HEADER}${lineOf('npx --no uncheck staged')}\n`)

    for (const [args, message] of [
      [['--only=oxlint', '--skip=oxlint'], '--only=oxlint and --skip=oxlint'],
      [['--require=tsc', '--skip=tsc'], '--require=tsc and --skip=tsc contradict each other.'],
    ] as const) {
      const contradicting = await prepare(...args)

      expect(contradicting.code).toBe(1)
      expect(contradicting.stderr).toContain(message)
    }

    expect(project.read(HOOK)).toBe(`${HEADER}${lineOf('npx --no uncheck staged')}\n`)
  })

  it('writes a hook that fixes and stages the files of a real commit', async () => {
    const project = createProject(layout)
    const file = project.inApp('src/loose.ts')

    expect((await project.run(['prepare', '--pre-commit'], { cwd: project.appDir })).code).toBe(0)

    project.write({ [file]: 'export const loose = "text";\n' })
    project.git('add', file)

    const fixed = commit(project, 'loose')

    expect(fixed.status).toBe(0)
    expect(fixed.output).toContain('✔ staged the fixes to src/loose.ts')
    expect(project.git('show', `HEAD:${file}`)).toBe("export const loose = 'text'\n")
    expect(project.read(file)).toBe("export const loose = 'text'\n")
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('writes a hook that only checks with --no-fix, which fails the commit', async () => {
    const project = createProject(layout)
    const file = project.inApp('src/loose.ts')
    const head = project.git('rev-parse', 'HEAD')

    await project.run(['prepare', '--pre-commit', '--no-fix'], { cwd: project.appDir })

    project.write({ [file]: 'export const loose = "text";\n' })
    project.git('add', file)

    const refused = commit(project, 'loose')

    expect(refused.status).not.toBe(0)
    expect(refused.output).toContain('oxfmt')
    expect(project.git('rev-parse', 'HEAD')).toBe(head)
    expect(project.git('show', `:${file}`)).toBe('export const loose = "text";\n')

    // As the hook says, `--no-verify` skips it.
    expect(commit(project, 'loose', {}, ['--no-verify']).status).toBe(0)
    expect(project.git('show', `HEAD:${file}`)).toBe('export const loose = "text";\n')
  })

  it('does nothing outside a git repository, where an install runs `prepare` as well', async () => {
    const project = createProject(layout, { tools: [], git: false })

    const skipped = await project.run(['prepare', '--pre-commit'], { cwd: project.appDir })

    expect(skipped).toMatchObject({
      code: 0,
      stdout: '○ no git repository found, nothing to prepare\n',
      stderr: '',
    })
  })
})

it('does nothing from inside the .git folder, which is not in a working tree', async () => {
  const project = createProject('single', { tools: [] })

  const skipped = await project.run(['prepare', '--pre-commit', '--cwd', '.git/hooks'])

  expect(skipped).toMatchObject({
    code: 0,
    stdout: '○ no git repository found, nothing to prepare\n',
  })
  expect(project.exists(HOOK)).toBe(false)
})
