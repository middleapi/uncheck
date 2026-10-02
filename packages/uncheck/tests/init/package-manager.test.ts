import { symlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { Env, Files } from '../utils/project'
import { REAL_GIT, cliError, temporaryDirectory } from '../utils/project'
import { bareProject, fakePackageManagers, initOutput, manifest, manifestOf } from './utils'

const WORKSPACES = { workspaces: ['packages/*'] }

describe('init installs with the package manager of the project', () => {
  it.each<[string, Files, Env, string]>([
    [
      'an npm lockfile',
      { 'pnpm-lock.yaml': null, 'package-lock.json': {} },
      {},
      'npm install --save-dev',
    ],
    ['a Yarn lockfile', { 'pnpm-lock.yaml': null, 'yarn.lock': '' }, {}, 'yarn add --dev'],
    ['a Bun lockfile', { 'pnpm-lock.yaml': null, 'bun.lock': '{}\n' }, {}, 'bun add --dev'],
    ['no lockfile', { 'pnpm-lock.yaml': null }, {}, 'npm install --save-dev'],
    [
      'no lockfile, started by pnpm dlx',
      { 'pnpm-lock.yaml': null },
      { npm_config_user_agent: 'pnpm/10.18.0 npm/? node/v24.9.0 linux x64' },
      'pnpm add --save-dev',
    ],
    [
      'no lockfile, started by bunx',
      { 'pnpm-lock.yaml': null },
      { npm_config_user_agent: 'bun/1.3.0 npm/? node/v24.3.0 linux x64' },
      'bun add --dev',
    ],
    [
      'a pnpm lockfile, started by npx',
      {},
      { npm_config_user_agent: 'npm/11.6.0 node/v24.9.0 linux x64 workspaces/false' },
      'pnpm add --save-dev',
    ],
    [
      'npm declared over a pnpm lockfile',
      manifest({ packageManager: 'npm@11.6.0' }),
      {},
      'npm install --save-dev',
    ],
  ])('with %s', async (_, files, userAgent, install) => {
    const project = bareProject(files)
    const { env, calls } = fakePackageManagers()
    const packageManager = install.split(' ')[0]!

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'], {
      env: { ...env, ...userAgent },
    })

    expect(project.normalize(stdout)).toBe(
      `uncheck init in <project>\n${initOutput(
        [
          `▶ ${install} uncheck oxlint oxfmt`,
          `${packageManager} added uncheck oxlint oxfmt`,
          '✔ package.json scripts check, fix and prepare written',
          '✔ pre-commit .git/hooks/pre-commit created',
        ],
        packageManager,
      )}`,
    )
    expect(exitCode).toBe(0)
    expect(calls()).toEqual([`${install} uncheck oxlint oxfmt`])
  })
})

describe('init adds to the root of a workspace', () => {
  it.each<[string, Files, string]>([
    [
      'pnpm',
      { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' },
      'pnpm add --save-dev --workspace-root',
    ],
    [
      'Yarn 1',
      { ...manifest(WORKSPACES), 'pnpm-lock.yaml': null, 'yarn.lock': '' },
      'yarn add --dev --ignore-workspace-root-check',
    ],
    [
      'Yarn 4',
      { ...manifest({ ...WORKSPACES, packageManager: 'yarn@4.10.3' }), 'pnpm-lock.yaml': null },
      'yarn add --dev',
    ],
    [
      'npm',
      { ...manifest(WORKSPACES), 'pnpm-lock.yaml': null, 'package-lock.json': {} },
      'npm install --save-dev',
    ],
  ])('with %s', async (_, files, install) => {
    const project = bareProject(files)
    const { env, calls } = fakePackageManagers()

    const { exitCode } = await project.uncheck(['init', '--yes'], { env })

    expect(exitCode).toBe(0)
    expect(calls()).toEqual([`${install} uncheck oxlint oxfmt sherif`])
  })
})

describe('init with Yarn 2+, which runs postinstall but not prepare', () => {
  it.each<[string, Files, Env]>([
    ['declared', manifest({ packageManager: 'yarn@4.10.3' }), {}],
    [
      'configured in .yarnrc.yml',
      { 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' },
      {},
    ],
    [
      'started by yarn dlx',
      {},
      { npm_config_user_agent: 'yarn/4.10.3 npm/? node/v24.9.0 linux x64' },
    ],
  ])('writes the hook from postinstall when %s', async (_, files, userAgent) => {
    const project = bareProject({ 'pnpm-lock.yaml': null, ...files })
    const { env } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'], {
      env: { ...env, ...userAgent },
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      '✔ package.json scripts check, fix and postinstall written\n✔ pre-commit .git/hooks/pre-commit created\n',
    )
    expect(manifestOf(project).scripts).toEqual({
      check: 'uncheck',
      fix: 'uncheck --fix',
      postinstall: 'uncheck prepare --pre-commit',
    })
  })

  it('warns that a package others install runs postinstall too', async () => {
    const project = bareProject({
      ...manifest({ private: false, packageManager: 'yarn@4.10.3' }),
      'pnpm-lock.yaml': null,
    })
    const { env } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'], { env })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      '✔ pre-commit .git/hooks/pre-commit created\n○ postinstall also runs where this package is installed, turn it off while packing, for example with pinst\n',
    )
  })
})

describe('init stops when the install does not work', () => {
  it('sets up nothing else after a failed install', async () => {
    const project = bareProject()
    const { env, calls } = fakePackageManagers()
    const before = project.read('package.json')

    const { exitCode, stdout, stderr } = await project.uncheck(['init', '--yes'], {
      env: { ...env, FAKE_INSTALL_FAILS: '1' },
    })

    expect(exitCode).toBe(1)
    expect(project.normalize(stdout)).toBe(
      'uncheck init in <project>\n▶ pnpm add --save-dev uncheck oxlint oxfmt\n',
    )
    expect(stderr).toBe(
      `pnpm: install failed\n${cliError('`pnpm add --save-dev uncheck oxlint oxfmt` failed, so nothing else was set up. Run uncheck init again once it installs')}`,
    )
    expect(calls()).toEqual(['pnpm add --save-dev uncheck oxlint oxfmt'])
    expect(project.read('package.json')).toBe(before)
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })

  it('says so when the package manager is not installed', async () => {
    const project = bareProject()
    const onlyGit = temporaryDirectory()

    symlinkSync(REAL_GIT, join(onlyGit, 'git'))

    const { exitCode, stderr } = await project.uncheck(['init', '--yes'], {
      env: { PATH: onlyGit },
    })

    expect(exitCode).toBe(1)
    expect(stderr).toBe(cliError('pnpm is not installed, install it and run uncheck init again'))
  })
})
