import { readdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Project } from '../utils/project'
import {
  LAYOUTS,
  monorepo,
  PERMISSIONS_ENFORCED,
  singleRepo,
  temporaryDirectory,
  wrappedGit,
} from '../utils/project'
import { HEADER, hookLine, notWritten, prepare, shownHook, written } from './utils'

const HOOK = '.git/hooks/pre-commit'

function leftoverLocksAndCopies(project: Project, folder = '.git/hooks'): string[] {
  return readdirSync(project.path(folder)).filter((name) => /\.(?:lock|uncheck-\w+)$/.test(name))
}

describe.each(LAYOUTS)('prepare failing to write the hook in a $name', ({ create, app }) => {
  it('reports a repository git refuses to work in', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await prepare(project, [], {
      cwd: app,
      env: { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      `✘ pre-commit not written, git refuses the repository: detected dubious ownership in repository at '${project.dir}'\n`,
    )
    expect(project.exists(HOOK)).toBe(false)
  })

  it.runIf(PERMISSIONS_ENFORCED)('reports a hooks folder it may not write to', async () => {
    const project = create().chmod('.git/hooks', 0o555)

    const { exitCode, stdout, stderr } = await prepare(project, [], { cwd: app })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        shownHook(project, app),
        `EACCES: permission denied, open '${project.path(`${HOOK}.lock`)}'`,
      ),
    )
    expect(project.exists(HOOK)).toBe(false)
  })

  it.runIf(PERMISSIONS_ENFORCED)('reports a hook it may not read and leaves it alone', async () => {
    const project = create()
      .write({ [HOOK]: '#!/bin/sh\npnpm test\n' })
      .chmod(HOOK, 0o200)

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        shownHook(project, app),
        `EACCES: permission denied, open '${project.path(HOOK)}'`,
      ),
    )
    expect(project.chmod(HOOK, 0o644).read(HOOK)).toBe('#!/bin/sh\npnpm test\n')
    expect(leftoverLocksAndCopies(project)).toEqual([])
  })

  it('reports a hooks folder it cannot create below a file', async () => {
    const project = create()
    project.git('config', 'core.hooksPath', 'package.json/hooks')

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        shownHook(project, app, 'package.json/hooks/pre-commit'),
        `ENOTDIR: not a directory, mkdir '${project.path('package.json/hooks')}'`,
      ),
    )
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('reports a hook that is a folder and releases its lock', async () => {
    const project = create().write({ [`${HOOK}/.keep`]: '' })

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    // Node 26 adds the path to the message.
    expect(stdout.replace(` '${project.path(HOOK)}'`, '')).toBe(
      notWritten(shownHook(project, app), 'EISDIR: illegal operation on a directory, read'),
    )
    expect(leftoverLocksAndCopies(project)).toEqual([])
  })

  it('reports a linked script whose name leaves no room for the copy it swaps in', async () => {
    const name = 'x'.repeat(240)
    const project = create({ [`scripts/${name}`]: '#!/bin/sh\npnpm test\n' })
    project.link(HOOK, `../../scripts/${name}`)

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout.replace(/\.uncheck-[\da-f]{12}'/, ".uncheck-<random>'")).toBe(
      notWritten(
        shownHook(project, app),
        `ENAMETOOLONG: name too long, open '${project.path('scripts', name)}.uncheck-<random>'`,
      ),
    )
    expect(project.read(`scripts/${name}`)).toBe('#!/bin/sh\npnpm test\n')
    expect(leftoverLocksAndCopies(project, 'scripts')).toEqual([])
  })
})

describe('prepare waiting for the lock of the hook', () => {
  it('gives up on a lock held for too long and leaves it to its owner', async () => {
    const project = singleRepo().write({ [`${HOOK}.lock`]: '' })

    const { exitCode, stdout } = await prepare(project)

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(HOOK, `EEXIST: file already exists, open '${project.path(`${HOOK}.lock`)}'`),
    )
    expect(project.exists(HOOK)).toBe(false)
    expect(project.exists(`${HOOK}.lock`)).toBe(true)
  })
})

describe('prepare in every package of a monorepo at once', () => {
  it('keeps the line of every package, as a workspace install running each prepare script does', async () => {
    const packages = ['core', 'app', 'web', 'docs', 'cli']
    const project = monorepo(
      Object.fromEntries(
        packages.map((name) => [
          `packages/${name}/package.json`,
          { name: `@repo/${name}`, version: '1.0.0', private: true },
        ]),
      ),
    )
    const folders = ['', ...packages.map((name) => `packages/${name}/`)]
    const atLock = temporaryDirectory()
    // Relies on `git config --show-scope` being the last git call before the lock.
    const env = wrappedGit(
      `case " $* " in *" --show-scope "*) "$GIT" "$@"; status=$?; touch '${atLock}'/$$; exit $status;; esac`,
    )
    project.write({ [`${HOOK}.lock`]: '' })

    const running = folders.map((folder) => prepare(project, [], { cwd: folder, env }))
    const endedEarly = Promise.race(running).then(({ stdout }) => {
      throw new Error(`A run ended while the lock was held:\n${stdout}`)
    })

    await Promise.race([
      endedEarly,
      vi.waitFor(() => expect(readdirSync(atLock)).toHaveLength(folders.length), {
        timeout: 30_000,
        interval: 10,
      }),
    ])
    await sleep(200)
    rmSync(project.path(`${HOOK}.lock`))
    const runs = await Promise.all(running)

    expect(runs.map(({ exitCode }) => exitCode)).toEqual(folders.map(() => 0))
    expect(runs.map(({ stdout }) => stdout.split('\n')[0])).toEqual(
      folders.map((folder) =>
        expect.stringMatching(
          new RegExp(
            `^✔ pre-commit ${folder === '' ? '' : `${project.dir}/`}\\.git/hooks/pre-commit (?:created|updated)$`,
          ),
        ),
      ),
    )
    expect(runs.filter(({ stdout }) => stdout.split('\n')[0]!.endsWith(' created'))).toHaveLength(1)
    expect(project.read(HOOK).split('\n').sort()).toEqual(
      [...HEADER.split('\n'), ...folders.map((folder) => hookLine(folder))].sort(),
    )
    expect(leftoverLocksAndCopies(project)).toEqual([])
  })
})

describe('prepare in a package whose folder name sh would misread', () => {
  it.each(['a"b', 'a$b', 'a`b', 'a\\b', 'a\nb'])('writes nothing for %j', async (name) => {
    const project = monorepo({
      [`packages/${name}/package.json`]: { name: 'odd', version: '1.0.0', private: true },
    })

    const { exitCode, stdout } = await prepare(project, [], { cwd: `packages/${name}` })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        project.path(HOOK),
        `sh would misread the folder name ${JSON.stringify(`packages/${name}`)} between double quotes`,
      ),
    )
    expect(project.exists(HOOK)).toBe(false)
  })

  it('writes the line for a folder name with spaces and single quotes, which sh reads as it is', async () => {
    const name = "it's my app"
    const project = monorepo({
      [`packages/${name}/package.json`]: { name: 'spaced', version: '1.0.0', private: true },
    })

    const { stdout } = await prepare(project, [], { cwd: `packages/${name}` })

    expect(stdout).toBe(written(project.path(HOOK), 'created'))
    expect(project.read(HOOK)).toBe(`${HEADER}${hookLine(`packages/${name}/`)}\n`)
  })
})
