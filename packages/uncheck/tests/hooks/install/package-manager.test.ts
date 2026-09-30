import { symlinkSync } from 'node:fs'

import { createProject } from '../../_shared/project'

/** The package.json of the single fixture, with `packageManager` set. */
function manifest(packageManager?: string, extra: object = {}) {
  return JSON.stringify({
    name: 'single',
    private: true,
    type: 'module',
    devDependencies: { uncheck: '*' },
    ...(packageManager === undefined ? {} : { packageManager }),
    ...extra,
  })
}

async function hookOf(project: ReturnType<typeof createProject>, cwd = '.') {
  const { code, stdout, stderr } = await project.run(['hooks', 'install', 'claude'], { cwd })

  expect(stderr).toBe('')
  expect(code).toBe(0)

  return /The hook runs (.*) whenever the agent finishes a turn\./.exec(stdout)![1]
}

describe('single package', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm exec'],
    ['yarn.lock', 'yarn run --silent'],
    ['bun.lock', 'bunx --no-install'],
    ['bun.lockb', 'bunx --no-install'],
    ['package-lock.json', 'npx --no'],
  ])('runs the hook through the package manager of %s', async (lockfile, exec) => {
    const project = createProject('single', { tools: [], files: { [lockfile]: '' } })

    expect(await hookOf(project)).toBe(`${exec} uncheck hooks run --fix`)
  })

  it.each([
    ['pnpm@9.0.0', 'pnpm exec'],
    ['yarn@1.22.22', 'yarn run --silent'],
    ['yarn@4.18.0', 'yarn run -T --silent'],
    ['bun@1.2.0', 'bunx --no-install'],
    ['npm@10.9.0', 'npx --no'],
    // One uncheck does not know leaves the choice to the lockfile.
    ['deno@2.0.0', 'bunx --no-install'],
  ])('prefers the declared packageManager %s over the lockfile', async (packageManager, exec) => {
    const project = createProject('single', {
      tools: [],
      files: { 'package.json': manifest(packageManager), 'bun.lock': '' },
    })

    expect(await hookOf(project)).toBe(`${exec} uncheck hooks run --fix`)
  })

  it('skips a lockfile it cannot look at and falls back to npx without any', async () => {
    const project = createProject('single', { tools: [], files: { 'yarn.lock': '' } })

    // A link to itself cannot be followed (ELOOP), so it tells nothing.
    symlinkSync('pnpm-lock.yaml', project.path('pnpm-lock.yaml'))

    expect(await hookOf(project)).toBe('yarn run --silent uncheck hooks run --fix')

    project.remove('yarn.lock')
    project.remove('.claude')

    expect(await hookOf(project)).toBe('npx --no uncheck hooks run --fix')
  })

  it('installs outside a git repository and without a package.json', async () => {
    const project = createProject('single', {
      tools: [],
      git: false,
      files: { 'package.json': null, 'pnpm-lock.yaml': '' },
    })

    expect(await hookOf(project)).toBe('pnpm exec uncheck hooks run --fix')
    expect(await hookOf(project, 'src')).toBe('pnpm exec uncheck hooks run --fix')
    expect(project.exists('src/.claude/settings.json')).toBe(true)
  })
})

describe('monorepo', () => {
  it('finds the package manager of the workspace from a package', async () => {
    const project = createProject('monorepo', {
      tools: [],
      files: {
        'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
        'pnpm-lock.yaml': '',
      },
    })

    expect(await hookOf(project, 'packages/app')).toBe(
      'pnpm exec uncheck hooks run --fix --dir=packages/app',
    )
  })

  it('runs the root binary of a Yarn 2+ workspace unless the package declares uncheck itself', async () => {
    const project = createProject('monorepo', {
      tools: [],
      files: {
        'package.json': JSON.stringify({
          private: true,
          workspaces: ['packages/*'],
          devDependencies: { uncheck: '*' },
          packageManager: 'yarn@4.18.0',
        }),
        'yarn.lock': '',
        'packages/lib/package.json': JSON.stringify({
          name: '@monorepo/lib',
          dependencies: { uncheck: '*' },
        }),
      },
    })

    expect(await hookOf(project)).toBe('yarn run -T --silent uncheck hooks run --fix')

    const again = await project.run(['hooks', 'install', 'claude'])

    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')
    expect(await hookOf(project, 'packages/app')).toBe(
      'yarn run -T --silent uncheck hooks run --fix --dir=packages/app',
    )
    expect(await hookOf(project, 'packages/lib')).toBe(
      'yarn run --silent uncheck hooks run --fix --dir=packages/lib',
    )

    const reinstalled = await project.run(['hooks', 'install', 'claude'], { cwd: 'packages/lib' })

    expect(reinstalled.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')
  })

  it('names no directory outside a git repository', async () => {
    const project = createProject('monorepo', { tools: [], git: false })

    expect(await hookOf(project, 'packages/app')).toBe('npx --no uncheck hooks run --fix')
  })
})
