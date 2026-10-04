import { FULL_OXFMT, FULL_OXLINT, LAYOUTS, monorepo, report, singleRepo } from '../utils/project'
import { monorepoWithMismatchedVersions } from './utils'

const OTHERS_NOT_SELECTED = [
  '○ oxlint skipped, not selected by --only',
  '○ oxfmt skipped, not selected by --only',
  '○ tsc skipped, not selected by --only',
  '○ fallow skipped, not selected by --only',
]

function sherifSkipped(dir: string, reason: string): string[] {
  return [
    `uncheck in ${dir}`,
    `○ sherif skipped, ${reason}`,
    ...OTHERS_NOT_SELECTED,
    `✘ nothing to check: sherif ${reason}, oxlint not selected by --only, oxfmt not selected by --only, tsc not selected by --only, fallow not selected by --only`,
  ]
}

describe.each(LAYOUTS)('uncheck sherif in a $name', ({ create, app }) => {
  it('skips sherif when it is not installed', async () => {
    const project = create({}, { tools: ['oxlint', 'oxfmt', 'typescript'] })

    const { exitCode, stdout } = await project.uncheck(['--only=sherif', '--only=oxlint'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not installed',
      FULL_OXLINT,
      '✔ oxlint passed',
      '○ oxfmt skipped, not selected by --only',
      '○ tsc skipped, not selected by --only',
      '○ fallow skipped, not selected by --only',
      '✔ all checks passed (oxlint)',
    ])
    expect(exitCode).toBe(0)
  })

  it('skips sherif in a folder without a package.json', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'], { cwd: `${app}src` })

    expect(report(stdout)).toEqual(sherifSkipped(project.path(app, 'src'), 'no package.json found'))
    expect(exitCode).toBe(1)
  })

  it.each([
    ['is not JSON', '{ "name": \n'],
    ['is not an object', 'null\n'],
  ])('skips sherif when the package.json %s', async (_, manifest) => {
    const project = create({ 'package.json': manifest })

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'])

    expect(report(stdout)).toEqual(sherifSkipped(project.dir, 'no package.json found'))
    expect(exitCode).toBe(1)
  })

  it('skips sherif in a package that is not a workspace root', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'], { cwd: app })

    expect(report(stdout)).toEqual(sherifSkipped(project.path(app, '.'), 'not a workspace root'))
    expect(exitCode).toBe(1)
  })

  it('skips sherif when no package.json is among the given files', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck(['--only=sherif', `${app}src/index.ts`])

    expect(report(stdout)).toEqual(
      sherifSkipped(project.dir, 'no package.json among the given files'),
    )
    expect(exitCode).toBe(1)
  })

  it.each([
    ['only holds settings', 'onlyBuiltDependencies:\n  - esbuild\n'],
    ['is empty', ''],
  ])('skips sherif where the pnpm-workspace.yaml %s', async (_, workspace) => {
    const project = create({ 'pnpm-workspace.yaml': workspace })

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'])

    expect(report(stdout)).toEqual(sherifSkipped(project.dir, 'not a workspace root'))
    expect(exitCode).toBe(1)
  })

  it('takes a pnpm-workspace.yaml link that loops for no workspace', async () => {
    const project = create({ 'pnpm-workspace.yaml': null }).link(
      'pnpm-workspace.yaml',
      'pnpm-workspace.yaml',
    )

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'])

    expect(report(stdout)).toEqual(sherifSkipped(project.dir, 'not a workspace root'))
    expect(exitCode).toBe(1)
  })
})

describe('uncheck sherif in a single repo', () => {
  it('fails when sherif is required outside a workspace', async () => {
    const project = singleRepo()

    const { exitCode, stdout } = await project.uncheck(['--require=sherif'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '✘ sherif not a workspace root',
      FULL_OXLINT,
      '✔ oxlint passed',
      FULL_OXFMT,
      '✔ oxfmt passed',
      '▶ tsc -p tsconfig.json --noEmit',
      '✔ tsc passed',
      '○ fallow skipped, not installed',
      '✘ 1 of 4 checks failed: sherif',
    ])
    expect(exitCode).toBe(1)
  })
})

describe('uncheck sherif in a monorepo', () => {
  it.each(['packages/core/package.json', 'pnpm-workspace.yaml'])(
    'checks the whole workspace when %s is among the given files',
    async (file) => {
      const project = monorepo()

      const { exitCode, stdout } = await project.uncheck(['--only=sherif', file])

      expect(report(stdout)).toEqual([
        `uncheck in ${project.dir}`,
        '▶ sherif',
        '✔ sherif passed',
        ...OTHERS_NOT_SELECTED,
        '✔ all checks passed (sherif)',
      ])
      expect(exitCode).toBe(0)
    },
  )

  it('finds the packages of a pnpm-workspace.yaml with a byte order mark and a quoted key', async () => {
    const project = monorepo({ 'pnpm-workspace.yaml': '\uFEFF"packages":\n  - packages/*\n' })

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif',
      '✔ sherif passed',
      ...OTHERS_NOT_SELECTED,
      '✔ all checks passed (sherif)',
    ])
    expect(exitCode).toBe(0)
  })

  it('refuses to only report when the sherif field sets fix, which makes sherif fix files', async () => {
    const project = monorepoWithMismatchedVersions({ fix: true, select: 'highest' })

    project.git('add', '--', 'packages/app/package.json')

    const manifests = ['package.json', 'packages/app/package.json', 'packages/core/package.json']
    const before = manifests.map((file) => project.read(file))
    const status = project.git('status', '--porcelain')
    const refused =
      '✘ sherif would fix files while uncheck only reports, remove "fix": true from the sherif field of package.json'

    const runs = [
      { header: `uncheck in ${project.dir}`, run: await project.uncheck(['--only=sherif']) },
      {
        header: `uncheck in ${project.dir}`,
        run: await project.uncheck(['--fix', '--only=sherif'], { env: { CI: '1' } }),
      },
      {
        header: `uncheck staged in ${project.dir}`,
        run: await project.uncheck(['staged', '--only=sherif']),
      },
    ]

    for (const { header, run } of runs) {
      expect(report(run.stdout)).toEqual([
        header,
        refused,
        ...OTHERS_NOT_SELECTED,
        '✘ 1 of 1 checks failed: sherif',
      ])
      expect(run.exitCode).toBe(1)
    }

    expect(manifests.map((file) => project.read(file))).toEqual(before)
    expect(project.git('status', '--porcelain')).toBe(status)
  })

  it('finds a workspace declared in the workspaces field of package.json', async () => {
    const project = monorepo({ 'pnpm-workspace.yaml': null })
      .update('package.json', (manifest) => ({ ...manifest, workspaces: ['packages/*'] }))
      .update('packages/app/package.json', (manifest) => ({
        ...manifest,
        dependencies: { 'zod': '^3.0.0', '@repo/core': 'workspace:*' },
      }))

    const { exitCode, stdout } = await project.uncheck(['--only=sherif'])

    expect(stdout).toContain('unordered-dependencies')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      ...OTHERS_NOT_SELECTED,
      '✘ 1 of 1 checks failed: sherif',
      '  rerun with `--fix` to apply sherif fixes',
    ])
    expect(exitCode).toBe(1)
  })
})
