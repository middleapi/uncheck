import type { Project } from '../utils/project'
import { LAYOUTS, monorepo } from '../utils/project'
import { HEADER, hookLine, prepare, shownHook, written } from './utils'

const YARN = 'yarn run --silent uncheck staged --fix'

function declarePackageManager(project: Project, dir: string, packageManager: unknown): void {
  const manifest = JSON.parse(project.read(`${dir}package.json`)) as object

  project.write({ [`${dir}package.json`]: { ...manifest, packageManager } })
}

describe.each(LAYOUTS)('prepare picking the package manager in a $name', ({ create, app }) => {
  async function expectHookCommand(project: Project, command: string): Promise<void> {
    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(written(shownHook(project, app), 'created', command))
    expect(project.read('.git/hooks/pre-commit')).toBe(`${HEADER}${hookLine(app, command)}\n`)
  }

  it.each([
    ['pnpm-lock.yaml', 'pnpm exec uncheck staged --fix'],
    ['yarn.lock', YARN],
    ['bun.lock', 'bunx --no-install uncheck staged --fix'],
    ['bun.lockb', 'bunx --no-install uncheck staged --fix'],
    ['package-lock.json', 'npx --no uncheck staged --fix'],
  ])('runs uncheck through the package manager of %s', async (lockfile, command) => {
    const project = create({ 'pnpm-lock.yaml': null, [`${app}${lockfile}`]: '' })

    await expectHookCommand(project, command)
  })

  it.each([
    ['pnpm@10.0.0', 'pnpm exec uncheck staged --fix'],
    ['yarn@1.22.22', YARN],
    ['yarn@4.5.0', YARN],
    ['bun@1.2.0', 'bunx --no-install uncheck staged --fix'],
    ['npm@11.0.0', 'npx --no uncheck staged --fix'],
  ])(
    'runs uncheck through the declared packageManager %s over the lockfile',
    async (declared, command) => {
      const project = create({ 'pnpm-lock.yaml': null, [`${app}yarn.lock`]: '' })
      declarePackageManager(project, app, declared)

      await expectHookCommand(project, command)
    },
  )

  it.each([
    ['an unknown packageManager', 'deno@2.0.0'],
    ['a packageManager that is not a string', { name: 'bun' }],
  ])('falls back to the lockfile with %s', async (_, declared) => {
    const project = create({ 'pnpm-lock.yaml': null, [`${app}yarn.lock`]: '' })
    declarePackageManager(project, app, declared)

    await expectHookCommand(project, YARN)
  })

  it('skips a lockfile that cannot be resolved', async () => {
    const project = create({ 'pnpm-lock.yaml': null, [`${app}yarn.lock`]: '' })
    project.link(`${app}pnpm-lock.yaml`, 'pnpm-lock.yaml')

    await expectHookCommand(project, YARN)
  })

  it.each([
    ['not valid JSON', '{ "packageManager": "bun@1.2.0", }\n'],
    ['not an object', '"bun@1.2.0"\n'],
  ])('skips a package.json that is %s', async (_, manifest) => {
    const project = create({ 'pnpm-lock.yaml': null, [`${app}yarn.lock`]: '' })
    project.write({ [`${app}package.json`]: manifest })

    await expectHookCommand(project, YARN)
  })

  it('runs uncheck with npx --no when nothing names a package manager', async () => {
    const project = create({ 'pnpm-lock.yaml': null })
    declarePackageManager(project, '', undefined)

    await expectHookCommand(project, 'npx --no uncheck staged --fix')
  })
})

describe('prepare picking the package manager in the packages of a monorepo', () => {
  it('takes the package manager of the nearest folder that names one', async () => {
    const project = monorepo({ 'packages/app/bun.lockb': '' })
    const hook = project.path('.git/hooks/pre-commit')

    const app = await prepare(project, [], { cwd: 'packages/app' })
    const core = await prepare(project, [], { cwd: 'packages/core' })

    expect(app.stdout).toBe(written(hook, 'created', 'bunx --no-install uncheck staged --fix'))
    expect(core.stdout).toBe(written(hook, 'updated', 'pnpm exec uncheck staged --fix'))
    expect(project.read('.git/hooks/pre-commit')).toBe(
      [
        HEADER,
        '(cd "packages/app" && bunx --no-install uncheck staged --fix) || exit 1\n',
        '(cd "packages/core" && pnpm exec uncheck staged --fix) || exit 1\n',
      ].join(''),
    )
  })
})
