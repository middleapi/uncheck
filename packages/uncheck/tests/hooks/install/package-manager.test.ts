import { monorepo, singleRepo } from '../../utils/project'
import { installOutput } from './utils'

function manifest(packageManager: string) {
  return { 'package.json': { name: 'app', private: true, type: 'module', packageManager } }
}

describe('hooks install runs uncheck through the package manager of the project', () => {
  it.each([
    ['a Yarn lockfile', { 'pnpm-lock.yaml': null, 'yarn.lock': '' }, 'yarn run --silent'],
    ['a Bun lockfile', { 'pnpm-lock.yaml': null, 'bun.lock': '{}\n' }, 'bunx --no-install'],
    ['a binary Bun lockfile', { 'pnpm-lock.yaml': null, 'bun.lockb': '' }, 'bunx --no-install'],
    ['an npm lockfile', { 'pnpm-lock.yaml': null, 'package-lock.json': {} }, 'npx --no'],
    ['no lockfile', { 'pnpm-lock.yaml': null }, 'npx --no'],
    ['npm declared over a pnpm lockfile', manifest('npm@10.9.0'), 'npx --no'],
    [
      'Yarn 1 declared',
      { ...manifest('yarn@1.22.22'), 'pnpm-lock.yaml': null },
      'yarn run --silent',
    ],
    [
      'Yarn 4 declared, which runs the binaries of the root with -T',
      { ...manifest('yarn@4.5.0'), 'pnpm-lock.yaml': null },
      'yarn run -T --silent',
    ],
    [
      'an unknown package manager declared over a pnpm lockfile',
      manifest('deno@2.0.0'),
      'pnpm exec',
    ],
  ])('with %s', async (_, files, exec) => {
    const project = singleRepo(files)
    const command = `${exec} uncheck hooks run --fix`

    const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude'])

    expect(exitCode).toBe(0)
    expect(stdout).toBe(installOutput(['Claude Code .claude/settings.json created'], command))
  })
})

describe('hooks install in a Yarn 4 monorepo', () => {
  it("runs the root's binary unless the package declares uncheck itself", async () => {
    const project = monorepo({
      'package.json': {
        name: 'monorepo',
        private: true,
        workspaces: ['packages/*'],
        devDependencies: { uncheck: '^0.0.3' },
        packageManager: 'yarn@4.5.0',
      },
      'pnpm-workspace.yaml': null,
      'pnpm-lock.yaml': null,
      'yarn.lock': '',
      'packages/core/package.json': {
        name: '@repo/core',
        private: true,
        devDependencies: { uncheck: '^0.0.3' },
      },
      'packages/cli/package.json': {
        name: '@repo/cli',
        private: true,
        dependencies: { uncheck: '^0.0.3' },
      },
    })

    for (const [cwd, command] of [
      ['.', 'yarn run -T --silent uncheck hooks run --fix'],
      ['packages/app', 'yarn run -T --silent uncheck hooks run --fix --dir=packages/app'],
      ['packages/core', 'yarn run --silent uncheck hooks run --fix --dir=packages/core'],
      ['packages/cli', 'yarn run --silent uncheck hooks run --fix --dir=packages/cli'],
    ] as const) {
      const { exitCode, stdout } = await project.uncheck(['hooks', 'install', 'claude'], { cwd })

      expect(exitCode).toBe(0)
      expect(stdout).toBe(installOutput(['Claude Code .claude/settings.json created'], command))
    }
  })
})
