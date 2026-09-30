import { chmodSync, statSync } from 'node:fs'

import { createProject, eachLayout } from '../_shared/project'
import { commit, fakeRunner, HEADER, shownFrom } from './helpers'

/** The dispatcher husky 9 generates as `_/h`, which the shims in `_` source. */
const DISPATCHER = [
  '#!/usr/bin/env sh',
  'n=$(basename "$0")',
  's=$(dirname "$(dirname "$0")")/$n',
  '[ ! -f "$s" ] && exit 0',
  'export PATH="node_modules/.bin:$PATH"',
  'sh -e "$s" "$@"',
  'c=$?',
  '[ $c != 0 ] && echo "husky - $n script failed (code $c)"',
  'exit $c',
  '',
].join('\n')

const SHIM = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'

eachLayout('$layout', ({ layout }) => {
  const within = (command: string) =>
    layout === 'single' ? command : `(cd "packages/app" && ${command})`

  function huskyProject(hook: string, tools?: []) {
    const project = createProject(layout, {
      tools,
      files: { '.husky/_/h': DISPATCHER, '.husky/_/pre-commit': SHIM, '.husky/pre-commit': hook },
    })

    chmodSync(project.path('.husky/_/pre-commit'), 0o755)
    project.git('config', 'core.hooksPath', '.husky/_')

    return project
  }

  it('writes the hook the husky 9 dispatcher runs, not its generated shim, and keeps its mode', async () => {
    const project = huskyProject('npx lint-staged\n', [])
    const cwd = project.appDir
    const shown = shownFrom(project, cwd, '.husky/pre-commit')
    const prepare = (...args: string[]) =>
      project.run(['prepare', '--pre-commit', ...args], { cwd })
    const line = `${within('npx --no uncheck staged --fix')} || exit 1`

    const updated = await prepare()

    expect(updated.code).toBe(0)
    expect(updated.stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    expect(project.read('.husky/pre-commit')).toBe(`${line}\nnpx lint-staged\n`)
    expect(project.read('.husky/_/pre-commit')).toBe(SHIM)
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
    // The dispatcher runs it with `sh`, and a changed mode would be a change to commit.
    expect(statSync(project.path('.husky/pre-commit')).mode & 0o777).toBe(0o644)

    expect((await prepare()).stdout).toContain(`✔ pre-commit ${shown} unchanged\n`)
    expect(statSync(project.path('.husky/pre-commit')).mode & 0o777).toBe(0o644)

    const runner = fakeRunner(project)

    expect(commit(project, 'passes', runner.env, ['--allow-empty']).status).toBe(0)
    expect(runner.ran()).toEqual([
      `${project.app} --no uncheck staged --fix`,
      `${project.root} lint-staged`,
    ])

    project.write({ [project.inApp('fail')]: '' })

    const failed = commit(project, 'fails', runner.env, ['--allow-empty'])

    expect(failed.status).not.toBe(0)
    expect(failed.output).toContain('husky - pre-commit script failed (code 1)')
    expect(runner.ran()).toEqual([`${project.app} --no uncheck staged --fix`])

    // A hook committed as executable stays so.
    chmodSync(project.path('.husky/pre-commit'), 0o755)

    expect((await prepare('--no-fix')).stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    expect(statSync(project.path('.husky/pre-commit')).mode & 0o777).toBe(0o755)
    expect(project.read('.husky/pre-commit')).toBe(
      `${within('npx --no uncheck staged')} || exit 1\nnpx lint-staged\n`,
    )
  })

  it('writes a husky hook that fixes and stages the files of a real commit', async () => {
    const project = huskyProject('echo "husky ran"\n')
    const file = project.inApp('src/loose.ts')

    await project.run(['prepare', '--pre-commit'], { cwd: project.appDir })

    project.write({ [file]: 'export const loose = "text";\n' })
    project.git('add', file)

    const fixed = commit(project, 'loose')

    expect(fixed.status).toBe(0)
    expect(fixed.output).toContain('husky ran')
    expect(project.git('show', `HEAD:${file}`)).toBe("export const loose = 'text'\n")
  })

  it('creates the hook the Vite+ dispatcher runs when there is none', async () => {
    const project = createProject(layout, { tools: [], files: { '.vite-hooks/_/h': DISPATCHER } })

    project.git('config', 'core.hooksPath', '.vite-hooks/_')

    const created = await project.run(['prepare', '--pre-commit'], { cwd: project.appDir })

    expect(created.stdout).toContain(
      `✔ pre-commit ${shownFrom(project, project.appDir, '.vite-hooks/pre-commit')} created\n`,
    )
    expect(project.read('.vite-hooks/pre-commit')).toBe(
      `${HEADER}${within('npx --no uncheck staged --fix')} || exit 1\n`,
    )
    expect(project.exists('.vite-hooks/_/pre-commit')).toBe(false)
  })
})

it('keeps the line of every package in the husky hook of a monorepo', async () => {
  const project = createProject('monorepo', {
    tools: [],
    files: {
      '.husky/_/h': DISPATCHER,
      '.husky/_/pre-commit': SHIM,
      '.husky/pre-commit': 'npm test\n',
    },
  })

  project.git('config', 'core.hooksPath', '.husky/_')

  expect((await project.run(['prepare', '--pre-commit'])).stdout).toContain(
    '✔ pre-commit .husky/pre-commit updated\n',
  )

  await project.run(['prepare', '--pre-commit', '--only=oxlint'], { cwd: 'packages/app' })

  expect(project.read('.husky/pre-commit')).toBe(
    'npx --no uncheck staged --fix || exit 1\n(cd "packages/app" && npx --no uncheck staged --fix --only=oxlint) || exit 1\nnpm test\n',
  )
  expect(project.read('.husky/_/pre-commit')).toBe(SHIM)
})
