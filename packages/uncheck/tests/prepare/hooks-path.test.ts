import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { Project } from '../_shared/project'
import { createProject, eachLayout } from '../_shared/project'
import { HEADER, HOOK, shownFrom } from './helpers'

const SHARED = '#!/bin/sh\necho "scanning for secrets"\n'

/** A shared hooks folder outside the repository, as a global core.hooksPath points to. */
function sharedHooks(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uncheck-shared-hooks-')))

  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'pre-commit'), SHARED)

  return dir
}

/**
 * The environment of a git before 2.26, which has no `--show-scope`: a `git` first on PATH that
 * refuses it as old git does and hands everything else to the real one.
 */
function oldGit(project: Project): Record<string, string> {
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

  project.write({
    'node_modules/.old-git/git': `#!/bin/sh\ncase "$*" in *--show-scope*) echo "error: unknown option show-scope" >&2; exit 129;; esac\nexec "${git}" "$@"\n`,
  })
  chmodSync(project.path('node_modules/.old-git/git'), 0o755)

  return { PATH: `${project.path('node_modules/.old-git')}${delimiter}${project.env.PATH ?? ''}` }
}

eachLayout('$layout', ({ layout }) => {
  const line = `${layout === 'single' ? 'npx --no uncheck staged --fix' : '(cd "packages/app" && npx --no uncheck staged --fix)'} || exit 1`

  const setUp = () => {
    const project = createProject(layout, { tools: [] })
    const prepare = (env: Record<string, string | undefined> = {}) =>
      project.run(['prepare', '--pre-commit'], { cwd: project.appDir, env })

    return { project, prepare }
  }

  it('writes into a core.hooksPath set by hand as it is, even one holding an `h` script', async () => {
    const { project, prepare } = setUp()

    project.write({ '.githooks/h': 'echo "help"\n' })
    project.git('config', 'core.hooksPath', '.githooks')

    const created = await prepare()

    expect(created.stdout).toContain(
      `✔ pre-commit ${shownFrom(project, project.appDir, '.githooks/pre-commit')} created\n`,
    )
    expect(project.read('.githooks/pre-commit')).toBe(`${HEADER}${line}\n`)
    expect(statSync(project.path('.githooks/pre-commit')).mode & 0o777).toBe(0o755)
    expect(project.exists(HOOK)).toBe(false)
    expect(project.exists('pre-commit')).toBe(false)

    // A `_` folder is only husky's with its dispatcher in it.
    project.git('config', 'core.hooksPath', '.hooks/_')

    await prepare()

    expect(project.read('.hooks/_/pre-commit')).toBe(`${HEADER}${line}\n`)
    expect(project.exists('.hooks/pre-commit')).toBe(false)
  })

  it('leaves the core.hooksPath of the global git config alone, since every repository runs it', async () => {
    const { project, prepare } = setUp()
    const shared = sharedHooks()

    project.git('config', '--file', project.globalConfig, 'core.hooksPath', shared)

    const refused = await prepare()

    expect(refused).toMatchObject({
      code: 0,
      stdout: `✘ pre-commit ${shared}/pre-commit not written, core.hooksPath is set in the global git config, so every repository runs it\n`,
    })
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED)

    // The repository's own setting wins.
    project.git('config', 'core.hooksPath', '.githooks')

    expect((await prepare()).stdout).toContain(' created\n')
    expect(project.read('.githooks/pre-commit')).toBe(`${HEADER}${line}\n`)
  })

  it('leaves a core.hooksPath alone that a file included by the global config sets', async () => {
    const { project, prepare } = setUp()
    const shared = sharedHooks()
    const included = project.path('node_modules/.work.gitconfig')

    project.write({ 'node_modules/.work.gitconfig': '' })
    project.git('config', '--file', project.globalConfig, 'include.path', included)
    project.git('config', '--file', included, 'core.hooksPath', shared)

    expect((await prepare()).stdout).toContain(
      'not written, core.hooksPath is set in the global git config',
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED)
  })

  it('leaves the core.hooksPath of the system git config alone', async () => {
    const { project, prepare } = setUp()
    const shared = sharedHooks()
    const system = project.path('node_modules/.system.gitconfig')

    project.write({ 'node_modules/.system.gitconfig': `[core]\n\thooksPath = ${shared}\n` })

    const env = { GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: system }

    expect((await prepare(env)).stdout).toBe(
      `✘ pre-commit ${shared}/pre-commit not written, core.hooksPath is set in the system git config, so every repository runs it\n`,
    )
    expect((await prepare({ ...env, ...oldGit(project) })).stdout).toContain(
      'not written, core.hooksPath is set in the system git config',
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED)
  })

  it('tells where core.hooksPath is set with a git too old to say itself', async () => {
    const { project, prepare } = setUp()
    const env = oldGit(project)

    // Unset, it is the hooks folder of the repository.
    expect((await prepare(env)).stdout).toContain(
      `✔ pre-commit ${shownFrom(project, project.appDir)} created\n`,
    )

    // Global, through an include, which a scope option has git read only with --includes.
    const shared = sharedHooks()
    const included = project.path('node_modules/.work.gitconfig')

    project.write({ 'node_modules/.work.gitconfig': '' })
    project.git('config', '--file', project.globalConfig, 'include.path', included)
    project.git('config', '--file', included, 'core.hooksPath', shared)

    expect((await prepare(env)).stdout).toContain(
      'not written, core.hooksPath is set in the global git config',
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED)

    // Local, over the global one.
    project.git('config', 'core.hooksPath', '.githooks')

    expect((await prepare(env)).stdout).toContain(' created\n')
    expect(project.read('.githooks/pre-commit')).toBe(`${HEADER}${line}\n`)
  })
})
