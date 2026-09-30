import type { Project } from '../_shared/project'
import { createProject, eachLayout } from '../_shared/project'
import { HEADER, HOOK } from './helpers'

/** The runner the hook written from `cwd` runs uncheck through. */
async function runnerOf(project: Project, cwd = project.appDir): Promise<string | undefined> {
  const { code, stdout } = await project.run(['prepare', '--pre-commit'], { cwd })

  expect(code).toBe(0)

  return /The hook runs (.*) uncheck staged --fix before every commit/.exec(stdout)?.[1]
}

function manifest(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ name: 'app', version: '1.0.0', private: true, ...fields }, null, 2)}\n`
}

eachLayout('$layout', ({ layout }) => {
  it('runs uncheck through the package manager of the lockfile next to the package', async () => {
    const project = createProject(layout, { tools: [] })

    for (const [lockfile, runner] of [
      ['pnpm-lock.yaml', 'pnpm exec'],
      ['yarn.lock', 'yarn run --silent'],
      ['bun.lock', 'bunx --no-install'],
      ['bun.lockb', 'bunx --no-install'],
      ['package-lock.json', 'npx --no'],
    ] as const) {
      project.write({ [project.inApp(lockfile)]: '' })

      expect(await runnerOf(project), lockfile).toBe(runner)

      project.remove(project.inApp(lockfile))
    }

    // pnpm first, when a project changed managers and kept the old lockfile.
    project.write({ [project.inApp('yarn.lock')]: '', [project.inApp('pnpm-lock.yaml')]: '' })

    expect(await runnerOf(project)).toBe('pnpm exec')
    expect(project.read(HOOK)).toContain('pnpm exec uncheck staged --fix')
  })

  it('takes the package manager from the packageManager field over any lockfile', async () => {
    const project = createProject(layout, {
      tools: [],
      files: { [layout === 'single' ? 'yarn.lock' : 'packages/app/yarn.lock']: '' },
    })

    for (const [packageManager, runner] of [
      ['pnpm@9.15.0', 'pnpm exec'],
      ['bun@1.2.0', 'bunx --no-install'],
      ['npm@10.9.0', 'npx --no'],
      // Yarn 2+ runs the binaries of the workspace `prepare` runs in, which is the package's own.
      ['yarn@4.5.0', 'yarn run --silent'],
      ['yarn@1.22.22', 'yarn run --silent'],
      // A manager uncheck does not know, or a field that is not a string, leaves it to the lockfile.
      ['deno@2.0.0', 'yarn run --silent'],
      [42, 'yarn run --silent'],
    ] as const) {
      project.write({ [project.inApp('package.json')]: manifest({ packageManager }) })

      expect(await runnerOf(project), String(packageManager)).toBe(runner)
    }
  })

  it('runs uncheck through npx when nothing says which package manager the project uses', async () => {
    const project = createProject(layout, {
      tools: [],
      files:
        layout === 'monorepo' ? { 'package.json': manifest({ workspaces: ['packages/*'] }) } : {},
    })

    expect(await runnerOf(project)).toBe('npx --no')
    expect(project.read(HOOK)).toContain('npx --no uncheck staged --fix')
  })

  it('switches the lines older versions wrote to the current runner in place', async () => {
    const project = createProject(layout, { tools: [] })
    const within = (command: string) =>
      layout === 'single' ? command : `(cd "packages/app" && ${command})`

    for (const [old, lockfile, runner] of [
      ['npx uncheck staged --fix', 'package-lock.json', 'npx --no'],
      ['yarn uncheck staged --fix', 'yarn.lock', 'yarn run --silent'],
      ['yarn run -T --silent uncheck staged --fix', 'yarn.lock', 'yarn run --silent'],
      ['bunx uncheck staged --fix', 'bun.lock', 'bunx --no-install'],
      ['uncheck staged --fix', 'pnpm-lock.yaml', 'pnpm exec'],
    ] as const) {
      project.write({
        [project.inApp(lockfile)]: '',
        [HOOK]: `${HEADER}${within(old)} || exit 1\nnpm test\n`,
      })

      await runnerOf(project)

      expect(project.read(HOOK), old).toBe(
        `${HEADER}${within(`${runner} uncheck staged --fix`)} || exit 1\nnpm test\n`,
      )

      project.remove(project.inApp(lockfile))
    }
  })
})

describe('monorepo', () => {
  it('takes the package manager of the workspace top for a package that declares none', async () => {
    const project = createProject('monorepo', { tools: [] })

    // The fixture declares npm at the top.
    expect(await runnerOf(project, 'packages/lib')).toBe('npx --no')

    project.write({
      'package.json': manifest({ workspaces: ['packages/*'], packageManager: 'pnpm@9.15.0' }),
    })

    expect(await runnerOf(project, 'packages/lib')).toBe('pnpm exec')
    expect(await runnerOf(project, '.')).toBe('pnpm exec')

    project.write({
      'package.json': manifest({ workspaces: ['packages/*'] }),
      'yarn.lock': '',
    })

    expect(await runnerOf(project, 'packages/lib')).toBe('yarn run --silent')
    expect(project.read(HOOK)).toBe(
      `${HEADER}(cd "packages/lib" && yarn run --silent uncheck staged --fix) || exit 1\npnpm exec uncheck staged --fix || exit 1\n`,
    )
  })
})
