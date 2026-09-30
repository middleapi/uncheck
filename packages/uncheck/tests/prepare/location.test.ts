import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Env } from '../utils/project'
import { gitConfig, LAYOUTS, temporaryDirectory, wrappedGit } from '../utils/project'
import {
  DISPATCHER,
  HEADER,
  hookLine,
  HUSKY_SHIM,
  installHusky,
  notWritten,
  prepare,
  shownHook,
  written,
} from './utils'

const SHARED_HOOK = '#!/bin/sh\necho "scanning for secrets"\n'

function withGitWithoutShowScope(env: Env = {}): Env {
  return {
    ...env,
    ...wrappedGit(
      `case " $* " in *" --show-scope "*) echo "error: unknown option 'show-scope'" >&2; exit 129;; esac`,
    ),
  }
}

function sharedHooks(): string {
  const dir = temporaryDirectory()

  writeFileSync(join(dir, 'pre-commit'), SHARED_HOOK)

  return dir
}

describe.each(LAYOUTS)('prepare with core.hooksPath in a $name', ({ create, app }) => {
  it('writes into a hooks folder set in the repository config', async () => {
    const project = create()
    project.git('config', 'core.hooksPath', '.githooks')

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app, '.githooks/pre-commit'), 'created'))
    expect(project.read('.githooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(project.mode('.githooks/pre-commit')).toBe(0o755)
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })

  it('names a hooks folder outside the project by its full path', async () => {
    const project = create()
    const outside = temporaryDirectory()
    project.git('config', 'core.hooksPath', outside)

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(join(outside, 'pre-commit'), 'created'))
    expect(readFileSync(join(outside, 'pre-commit'), 'utf8')).toBe(`${HEADER}${hookLine(app)}\n`)
  })

  it.each([
    ['global', (file: string) => ({ GIT_CONFIG_GLOBAL: file })],
    ['system', (file: string) => ({ GIT_CONFIG_SYSTEM: file, GIT_CONFIG_NOSYSTEM: undefined })],
  ])('leaves a hooks folder set in the %s config alone', async (scope, env) => {
    const project = create()
    const shared = sharedHooks()

    const { exitCode, stdout } = await prepare(project, [], {
      cwd: app,
      env: env(gitConfig(`[core]\n\thooksPath = ${shared}\n`)),
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        join(shared, 'pre-commit'),
        `core.hooksPath is set in the ${scope} git config, so every repository runs it`,
      ),
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED_HOOK)
  })

  it('leaves a hooks folder set in a file the global config includes alone', async () => {
    const project = create()
    const shared = sharedHooks()
    const included = gitConfig(`[core]\n\thooksPath = ${shared}\n`)

    const { stdout } = await prepare(project, [], {
      cwd: app,
      env: { GIT_CONFIG_GLOBAL: gitConfig(`[include]\n\tpath = ${included}\n`) },
    })

    expect(stdout).toBe(
      notWritten(
        join(shared, 'pre-commit'),
        'core.hooksPath is set in the global git config, so every repository runs it',
      ),
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED_HOOK)
  })

  it('writes into a hooks folder the repository config sets over the global one', async () => {
    const project = create()
    project.git('config', 'core.hooksPath', '.githooks')

    const { stdout } = await prepare(project, [], {
      cwd: app,
      env: { GIT_CONFIG_GLOBAL: gitConfig(`[core]\n\thooksPath = ${sharedHooks()}\n`) },
    })

    expect(stdout).toBe(written(shownHook(project, app, '.githooks/pre-commit'), 'created'))
  })
})

describe.each(LAYOUTS)('prepare with a git older than 2.26 in a $name', ({ create, app }) => {
  it('writes the hook when core.hooksPath is not set', async () => {
    const project = create()

    const { stdout } = await prepare(project, [], { cwd: app, env: withGitWithoutShowScope() })

    expect(stdout).toBe(written(shownHook(project, app), 'created'))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
  })

  it('writes into a hooks folder set in the repository config', async () => {
    const project = create()
    project.git('config', 'core.hooksPath', '.githooks')

    const { stdout } = await prepare(project, [], { cwd: app, env: withGitWithoutShowScope() })

    expect(stdout).toBe(written(shownHook(project, app, '.githooks/pre-commit'), 'created'))
  })

  it.each([
    ['global', (file: string) => ({ GIT_CONFIG_GLOBAL: file })],
    ['system', (file: string) => ({ GIT_CONFIG_SYSTEM: file, GIT_CONFIG_NOSYSTEM: undefined })],
  ])('leaves a hooks folder set in the %s config alone', async (scope, env) => {
    const project = create()
    const shared = sharedHooks()

    const { stdout } = await prepare(project, [], {
      cwd: app,
      env: withGitWithoutShowScope(env(gitConfig(`[core]\n\thooksPath = ${shared}\n`))),
    })

    expect(stdout).toBe(
      notWritten(
        join(shared, 'pre-commit'),
        `core.hooksPath is set in the ${scope} git config, so every repository runs it`,
      ),
    )
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe(SHARED_HOOK)
  })
})

describe.each(LAYOUTS)('prepare with a hook dispatcher in a $name', ({ create, app }) => {
  function husky() {
    return installHusky(create(), 'echo "husky hook ran"\n')
  }

  it('writes the hook husky 9 runs, not its generated shim, and keeps its mode, also when unchanged', async () => {
    const project = husky()

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(written(shownHook(project, app, '.husky/pre-commit'), 'updated'))
    expect(project.read('.husky/pre-commit')).toBe(`${hookLine(app)}\necho "husky hook ran"\n`)
    expect(project.mode('.husky/pre-commit')).toBe(0o644)
    expect(project.read('.husky/_/pre-commit')).toBe(HUSKY_SHIM)

    const again = await prepare(project, [], { cwd: app })

    expect(again.stdout).toBe(written(shownHook(project, app, '.husky/pre-commit'), 'unchanged'))
    expect(project.mode('.husky/pre-commit')).toBe(0o644)
  })

  it('keeps the mode the user gave a husky hook when updating it', async () => {
    const project = husky()
    project.chmod('.husky/pre-commit', 0o700)

    const { exitCode, stdout } = await prepare(project, ['--no-fix'], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      written(shownHook(project, app, '.husky/pre-commit'), 'updated', 'pnpm exec uncheck staged'),
    )
    expect(project.read('.husky/pre-commit')).toBe(
      `${hookLine(app, 'pnpm exec uncheck staged')}\necho "husky hook ran"\n`,
    )
    expect(project.mode('.husky/pre-commit')).toBe(0o700)
  })

  it('creates the hook the Vite+ dispatcher runs, without making it executable', async () => {
    const project = create({ '.vite-hooks/_/h': DISPATCHER })
    project.git('config', 'core.hooksPath', '.vite-hooks/_')

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(shownHook(project, app, '.vite-hooks/pre-commit'), 'created'))
    expect(project.read('.vite-hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(project.mode('.vite-hooks/pre-commit') & 0o111).toBe(0)
    expect(project.exists('.vite-hooks/_/pre-commit')).toBe(false)
  })

  it('writes into a hooks folder with an h script as it is, when not named _', async () => {
    const project = create({ '.githooks/h': 'echo "help"\n' })
    project.git('config', 'core.hooksPath', '.githooks')

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(shownHook(project, app, '.githooks/pre-commit'), 'created'))
    expect(project.mode('.githooks/pre-commit')).toBe(0o755)
  })

  it('writes into a hooks folder named _ as it is, when its h cannot be read', async () => {
    const project = create()
    project.link('.hooks/_/h', 'h')
    project.git('config', 'core.hooksPath', '.hooks/_')

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(shownHook(project, app, '.hooks/_/pre-commit'), 'created'))
    expect(project.read('.hooks/_/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(project.mode('.hooks/_/pre-commit')).toBe(0o755)
  })
})

describe.each(LAYOUTS)('prepare with a symlinked hook in a $name', ({ create, app }) => {
  it('updates the script the link points to and keeps the link', async () => {
    const project = create({ 'scripts/pre-commit': '#!/bin/sh\npnpm test\n' })
    project.link('.git/hooks/pre-commit', '../../scripts/pre-commit')

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(shownHook(project, app), 'updated'))
    expect(lstatSync(project.path('.git/hooks/pre-commit')).isSymbolicLink()).toBe(true)
    expect(project.read('scripts/pre-commit')).toBe(`#!/bin/sh\n${hookLine(app)}\npnpm test\n`)
    expect(project.mode('scripts/pre-commit')).toBe(0o755)
  })

  it('creates the script a dangling link points to', async () => {
    const project = create()
    project.link('.git/hooks/pre-commit', '../../hooks/pre-commit')

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(shownHook(project, app), 'created'))
    expect(lstatSync(project.path('.git/hooks/pre-commit')).isSymbolicLink()).toBe(true)
    expect(project.read('hooks/pre-commit')).toBe(`${HEADER}${hookLine(app)}\n`)
    expect(project.mode('hooks/pre-commit')).toBe(0o755)
  })
})
