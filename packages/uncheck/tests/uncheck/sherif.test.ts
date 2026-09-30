import type { Project } from '../_shared/project'
import { createProject, eachLayout } from '../_shared/project'

/**
 * The monorepo with something for sherif to say: root dependencies out of order and two versions of
 * one dependency, with its install step off so a fix stays offline.
 */
function brokenWorkspace(sherif: Record<string, unknown> = {}) {
  const manifest = (name: string, react: string) =>
    `${JSON.stringify({ name, version: '1.0.0', private: true, type: 'module', dependencies: { react } }, null, 2)}\n`

  return createProject('monorepo', {
    files: {
      'package.json': `${JSON.stringify(
        {
          name: 'monorepo',
          version: '1.0.0',
          private: true,
          workspaces: ['packages/*'],
          type: 'module',
          devDependencies: { zod: '^3.0.0', react: '^18.0.0' },
          packageManager: 'npm@10.9.0',
          sherif: { noInstall: true, ...sherif },
        },
        null,
        2,
      )}\n`,
      'packages/app/package.json': manifest('@monorepo/app', '^18.0.0'),
      'packages/lib/package.json': manifest('@monorepo/lib', '^17.0.0'),
    },
  })
}

function dependencies(project: Project, manifest: string) {
  return JSON.parse(project.read(manifest)) as Record<string, Record<string, string>>
}

describe('uncheck sherif in a monorepo', () => {
  it('checks the workspace root and fixes it, aligning versions on the highest', async () => {
    const project = brokenWorkspace()

    const check = await project.run(['--only=sherif'])

    expect(check.code).toBe(1)
    expect(check.stdout).toContain('▶ sherif\n')
    expect(check.stdout).toContain('unordered-dependencies')
    expect(check.stdout).toContain('multiple-dependency-versions')
    expect(check.stdout).toContain(
      '✘ 1 of 1 checks failed: sherif\n  rerun with `--fix` to apply sherif fixes\n',
    )

    const fix = await project.run(['--only=sherif', '--fix'])

    expect(fix.code).toBe(0)
    expect(fix.stdout).toContain('▶ sherif --fix --select=highest\n')
    expect(Object.keys(dependencies(project, 'package.json').devDependencies!)).toEqual([
      'react',
      'zod',
    ])
    expect(dependencies(project, 'packages/lib/package.json').dependencies).toEqual({
      react: '^18.0.0',
    })

    const clean = await project.run(['--only=sherif'])

    expect(clean.code).toBe(0)
    expect(clean.stdout).toContain('✔ all checks passed (sherif)')
  })

  it('leaves the version choice to the sherif config when it makes one', async () => {
    const project = brokenWorkspace({ select: 'lowest' })

    const fix = await project.run(['--only=sherif', '--fix'])

    expect(fix.code).toBe(0)
    expect(fix.stdout).toContain('▶ sherif --fix\n')
    expect(dependencies(project, 'packages/app/package.json').dependencies).toEqual({
      react: '^17.0.0',
    })
  })

  it('only checks in CI, where sherif refuses to fix', async () => {
    const project = brokenWorkspace()

    const result = await project.run(['--only=sherif', '--fix'], { env: { CI: 'true' } })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('▶ sherif\n')
    expect(result.stdout).toContain('unordered-dependencies')
    expect(result.stdout).not.toContain('Cannot fix issues inside a CI environment')
    expect(dependencies(project, 'packages/lib/package.json').dependencies).toEqual({
      react: '^17.0.0',
    })
  })

  it('runs only when a package.json is among the given files', async () => {
    const project = brokenWorkspace()

    const code = await project.run(['--only=sherif', 'packages/app/src/index.ts'])

    expect(code.code).toBe(1)
    expect(code.stdout).toContain('○ sherif skipped, no package.json among the given files\n')
    expect(code.stdout).toContain(
      '✘ nothing to check: sherif no package.json among the given files, oxlint not selected by --only',
    )

    const manifest = await project.run(['--only=sherif', 'packages/lib/package.json'])

    expect(manifest.code).toBe(1)
    expect(manifest.stdout).toContain('▶ sherif\n')
    expect(manifest.stdout).toContain('multiple-dependency-versions')
  })

  it('skips a workspace sherif is not installed in', async () => {
    const project = createProject('monorepo', { tools: ['oxlint'] })

    const result = await project.run(['--only=sherif', '--only=oxlint'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('○ sherif skipped, not installed\n')
  })
})

eachLayout('uncheck sherif in a $layout repository', ({ layout }) => {
  it('runs only at a workspace root, which a pnpm-workspace.yaml makes too', async () => {
    const project = createProject(layout)

    const inApp = await project.run(['--only=sherif', '--only=oxlint'], { cwd: project.appDir })

    expect(inApp.code).toBe(0)
    expect(inApp.stdout).toContain('○ sherif skipped, not a workspace root\n')

    project.write({ [project.inApp('pnpm-workspace.yaml')]: 'packages:\n  - packages/*\n' })

    const pnpm = await project.run(['--only=sherif'], { cwd: project.appDir })

    expect(pnpm.stdout).toContain('▶ sherif\n')
  })

  it('skips a folder without a readable package.json', async () => {
    const project = createProject(layout)
    const run = () => project.run(['--only=sherif', '--only=oxlint'], { cwd: project.inApp('src') })

    const missing = await run()

    expect(missing.code).toBe(0)
    expect(missing.stdout).toContain('○ sherif skipped, no package.json found\n')

    for (const content of ['{ "name": ', '"a string"\n']) {
      project.write({ [project.inApp('src/package.json')]: content })

      const unreadable = await run()

      expect(unreadable.code).toBe(0)
      expect(unreadable.stdout).toContain('○ sherif skipped, no package.json found\n')
    }
  })
})
