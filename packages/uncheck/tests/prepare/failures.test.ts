import { readdirSync } from 'node:fs'
import process from 'node:process'

import type { Project } from '../utils/project'
import { LAYOUTS, monorepo, singleRepo } from '../utils/project'
import { chmod, HEADER, hookLine, notWritten, prepare, shownHook, written } from './utils'

const HOOK = '.git/hooks/pre-commit'

const ROOT_IGNORES_MODES = process.getuid?.() === 0

function leftoverLocksAndCopies(project: Project, folder = '.git/hooks'): string[] {
  return readdirSync(project.path(folder)).filter((name) => /\.(?:lock|uncheck-\w+)$/.test(name))
}

describe.each(LAYOUTS)('prepare failing to write the hook in a $name', ({ create, app }) => {
  // Root reads and writes a file whatever its mode.
  it.skipIf(ROOT_IGNORES_MODES)('reports a hooks folder it may not write to', async () => {
    const project = create()
    chmod(project, '.git/hooks', 0o555)
    onTestFinished(() => chmod(project, '.git/hooks', 0o755))

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

  it.skipIf(ROOT_IGNORES_MODES)('reports a hook it may not read and leaves it alone', async () => {
    const project = create().write({ [HOOK]: '#!/bin/sh\npnpm test\n' })
    chmod(project, HOOK, 0o200)
    onTestFinished(() => chmod(project, HOOK, 0o644))

    const { exitCode, stdout } = await prepare(project, [], { cwd: app })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        shownHook(project, app),
        `EACCES: permission denied, open '${project.path(HOOK)}'`,
      ),
    )
    chmod(project, HOOK, 0o644)
    expect(project.read(HOOK)).toBe('#!/bin/sh\npnpm test\n')
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
    expect(stdout).toBe(
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

    const runs = await Promise.all(folders.map((folder) => prepare(project, [], { cwd: folder })))

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
