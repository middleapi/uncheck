import type { Files, Layout, Project, ProjectOptions } from '../utils/project'
import { LAYOUTS, monorepo, report, singleRepo, TOOLS } from '../utils/project'

const OTHERS_NOT_SELECTED = [
  '○ sherif skipped, not selected by --only',
  '○ oxlint skipped, not selected by --only',
  '○ oxfmt skipped, not selected by --only',
]

const TSC_NOT_SELECTED = '○ tsc skipped, not selected by --only'

const NOT_SELECTED_REASONS =
  'sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only'

const ORPHAN = 'export const orphan = 1;\n'

interface KnipProjectOptions extends Pick<ProjectOptions, 'git'> {
  /** Merged into the top package.json. */
  readonly manifest?: object
}

/** A project with knip, whose script that runs uncheck makes knip count the tools uncheck runs as used. */
function withKnip(
  create: Layout['create'],
  files: Files = {},
  { git = 'commit', manifest = {} }: KnipProjectOptions = {},
): Project {
  const created = create(files, {
    tools: [...TOOLS, 'knip'],
    git: git === 'commit' ? 'init' : git,
  }).update('package.json', (current) => ({
    ...current,
    scripts: { check: 'uncheck' },
    ...manifest,
  }))

  return git === 'commit' ? created.commit('init') : created
}

function knipReport(
  heading: string,
  plan: string,
  outcome: 'passed' | 'failed',
): ReadonlyArray<string> {
  return [
    heading,
    ...OTHERS_NOT_SELECTED,
    plan,
    ...(outcome === 'passed'
      ? ['✔ knip passed', TSC_NOT_SELECTED, '✔ all checks passed (knip)']
      : ['✘ knip failed', TSC_NOT_SELECTED, '✘ 1 of 1 checks failed: knip']),
  ]
}

describe.each(LAYOUTS)('uncheck knip in a $name', ({ create, app }) => {
  it('runs knip on the whole project', async () => {
    const project = withKnip(create)

    const { exitCode, stdout } = await project.uncheck(['--only=knip'])

    expect(report(stdout)).toEqual(knipReport(`uncheck in ${project.dir}`, '▶ knip', 'passed'))
    expect(exitCode).toBe(0)
  })

  it('reports unused files and exports without fixing them, even with --fix', async () => {
    const utils = 'export const used = 1;\n\nexport const unusedHelper = 2;\n'
    const project = withKnip(create, {
      [`${app}src/orphan.ts`]: ORPHAN,
      [`${app}src/helpers.ts`]: utils,
      [`${app}src/main.ts`]: 'import { used } from "./helpers";\n\nexport const value = used;\n',
      [`${app}src/index.ts`]: 'export { value } from "./main";\n',
    })

    const { exitCode, stdout } = await project.uncheck(['--fix', '--only=knip'])

    expect(stdout).toContain(`${app}src/orphan.ts`)
    expect(stdout).toMatch(new RegExp(`unusedHelper +${app}src/helpers\\.ts:3:14`))
    expect(report(stdout)).toEqual(knipReport(`uncheck in ${project.dir}`, '▶ knip', 'failed'))
    expect(exitCode).toBe(1)
    expect(project.read(`${app}src/helpers.ts`)).toBe(utils)
    expect(project.git('status', '--porcelain')).toBe('')
  })

  it('checks the whole project for the given files', async () => {
    const project = withKnip(create, { [`${app}src/orphan.ts`]: ORPHAN })

    const { exitCode, stdout } = await project.uncheck(['--only=knip', `${app}src/index.ts`])

    expect(stdout).toContain(`${app}src/orphan.ts`)
    expect(report(stdout)).toEqual(knipReport(`uncheck in ${project.dir}`, '▶ knip', 'failed'))
    expect(exitCode).toBe(1)
  })

  it('skips knip when every given file is an image, a font or audio', async () => {
    const project = withKnip(create, {
      [`${app}assets/logo.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      [`${app}assets/font.woff2`]: '',
      [`${app}assets/ping.mp3`]: '',
    })
    const reason = 'only images, fonts and audio among the given files'

    const { exitCode, stdout } = await project.uncheck([
      '--only=knip',
      '--no-error-on-unmatched-pattern',
      `${app}assets`,
    ])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...OTHERS_NOT_SELECTED,
      `○ knip skipped, ${reason}`,
      TSC_NOT_SELECTED,
      `○ nothing to check: ${NOT_SELECTED_REASONS}, knip ${reason}, tsc not selected by --only`,
    ])
    expect(exitCode).toBe(0)
  })

  it('runs knip for an image whose extension is not lower case, as knip resolves its imports', async () => {
    const project = withKnip(create, { [`${app}assets/logo.PNG`]: '' })

    const { exitCode, stdout } = await project.uncheck(['--only=knip', `${app}assets/logo.PNG`])

    expect(report(stdout)).toEqual(knipReport(`uncheck in ${project.dir}`, '▶ knip', 'passed'))
    expect(exitCode).toBe(0)
  })

  it('skips knip in a folder without a package.json, unless it is required', async () => {
    const project = withKnip(create)
    const dir = project.path(app, 'src')

    const skipped = await project.uncheck(['--only=knip'], { cwd: `${app}src` })

    expect(report(skipped.stdout)).toEqual([
      `uncheck in ${dir}`,
      ...OTHERS_NOT_SELECTED,
      '○ knip skipped, no package.json found',
      TSC_NOT_SELECTED,
      `✘ nothing to check: ${NOT_SELECTED_REASONS}, knip no package.json found, tsc not selected by --only`,
    ])
    expect(skipped.exitCode).toBe(1)

    const required = await project.uncheck(['--only=knip', '--require=knip'], {
      cwd: `${app}src`,
    })

    expect(report(required.stdout)).toEqual([
      `uncheck in ${dir}`,
      ...OTHERS_NOT_SELECTED,
      '✘ knip no package.json found',
      TSC_NOT_SELECTED,
      '✘ 1 of 1 checks failed: knip',
    ])
    expect(required.exitCode).toBe(1)
  })

  it('fails when knip is required but not installed', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck(['--only=knip', '--require=knip'])

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...OTHERS_NOT_SELECTED,
      '✘ knip not installed',
      TSC_NOT_SELECTED,
      '✘ 1 of 1 checks failed: knip',
    ])
    expect(exitCode).toBe(1)
  })

  it('runs knip on the whole project in the pre-commit hook, where it only reports', async () => {
    const project = withKnip(create)

    project.stage({ [`${app}src/orphan.ts`]: ORPHAN })

    const { exitCode, stdout } = await project.uncheck(['staged', '--fix', '--only=knip'])

    expect(stdout).toContain(`${app}src/orphan.ts`)
    expect(report(stdout)).toEqual(
      knipReport(`uncheck staged in ${project.dir}`, '▶ knip', 'failed'),
    )
    expect(exitCode).toBe(1)
    expect(project.read(`${app}src/orphan.ts`)).toBe(ORPHAN)
  })
})

describe('uncheck knip in a single repo', () => {
  it('runs knip for a commit that only deletes files, which can leave imports unresolved', async () => {
    const project = withKnip(singleRepo)

    project.git('rm', '--quiet', '--', 'src/utils.ts')

    const { exitCode, stdout } = await project.uncheck(['staged', '--only=knip'])

    expect(stdout).toContain('Unresolved imports (1)')
    expect(report(stdout)).toEqual(
      knipReport(`uncheck staged in ${project.dir}`, '▶ knip', 'failed'),
    )
    expect(exitCode).toBe(1)
  })

  it('runs knip on its own in a package nested in the project', async () => {
    const project = withKnip(singleRepo, {
      'tools/gen/package.json': { name: 'gen', private: true, type: 'module' },
      'tools/gen/index.js': 'export const generated = 1;\n',
    })

    const { exitCode, stdout } = await project.uncheck(['--only=knip'], { cwd: 'tools/gen' })

    expect(report(stdout)).toEqual(
      knipReport(`uncheck in ${project.path('tools/gen')}`, '▶ knip', 'passed'),
    )
    expect(exitCode).toBe(0)
  })
})

const IN_WORKSPACE = '▶ knip --directory=../.. --workspace=packages/app'

describe('uncheck knip in a monorepo', () => {
  it('checks a package at the workspace root, reporting only on that package', async () => {
    const project = withKnip(monorepo)
    const dir = project.path('packages/app')

    const clean = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

    expect(report(clean.stdout)).toEqual(knipReport(`uncheck in ${dir}`, IN_WORKSPACE, 'passed'))
    expect(clean.exitCode).toBe(0)

    project.write({
      'packages/app/src/orphan.ts': ORPHAN,
      'packages/core/src/orphan.ts': ORPHAN,
    })

    const unused = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

    expect(unused.stdout).toContain('packages/app/src/orphan.ts')
    expect(unused.stdout).not.toContain('packages/core/src/orphan.ts')
    expect(report(unused.stdout)).toEqual(knipReport(`uncheck in ${dir}`, IN_WORKSPACE, 'failed'))
    expect(unused.exitCode).toBe(1)
  })

  it.each([
    [
      'a block of quoted globs with comments',
      "packages:\n  # all of them\n  - 'packages/*' # here\n",
    ],
    ['a block of double-quoted globs', 'packages:\n- "tools/*"\n- "packages/*"\n'],
    ['a block with Windows line endings', 'packages:\r\n  - packages/*\r\n'],
    ['brackets', 'packages: ["packages/*"]\n'],
    ['brackets across lines', 'packages: [\n  tools/*, # tools\n  packages/*,\n]\n'],
    ['a glob that matches deeper folders', "packages:\n  - 'packages/**'\n"],
    ['an exclusion of another folder', "packages:\n  - packages/*\n  - '!packages/core'\n"],
  ])('finds the package among the packages of a pnpm-workspace.yaml in %s', async (_, yaml) => {
    const project = withKnip(monorepo, { 'pnpm-workspace.yaml': yaml })

    const { exitCode, stdout } = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

    expect(report(stdout)).toEqual(
      knipReport(`uncheck in ${project.path('packages/app')}`, IN_WORKSPACE, 'passed'),
    )
    expect(exitCode).toBe(0)
  })

  it.each([
    ['only holds settings', 'onlyBuiltDependencies:\n  - esbuild\n', ['packages/*']],
    ['has no packages', 'packages:\ncatalog:\n  zod: ^3.0.0\n', { packages: ['packages/*'] }],
  ])(
    'finds the package among the workspaces of package.json when the pnpm-workspace.yaml %s',
    async (_, yaml, workspaces) => {
      const project = withKnip(
        monorepo,
        { 'pnpm-workspace.yaml': yaml },
        { manifest: { workspaces } },
      )

      const { exitCode, stdout } = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

      expect(report(stdout)).toEqual(
        knipReport(`uncheck in ${project.path('packages/app')}`, IN_WORKSPACE, 'passed'),
      )
      expect(exitCode).toBe(0)
    },
  )

  it.each([
    ['excludes it', "packages:\n  - packages/*\n  - '!packages/app'\n"],
    ['lists other folders', "packages:\n  - 'libs/*'\n"],
    ['lists none, over the workspaces of package.json', 'packages: [ ]\n'],
  ])('runs knip on its own in a package when the pnpm-workspace.yaml %s', async (_, yaml) => {
    const project = withKnip(
      monorepo,
      { 'pnpm-workspace.yaml': yaml },
      { manifest: { workspaces: ['packages/*'] } },
    )

    const { stdout } = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

    expect(report(stdout)).toContain('▶ knip')
  })

  it('runs knip on its own in a package outside git, where the workspace root is not looked for', async () => {
    const project = withKnip(monorepo, {}, { git: 'none' })

    const { stdout } = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

    expect(report(stdout)).toContain('▶ knip')
  })

  it('runs knip as it is in a package that is a workspace root itself', async () => {
    const project = withKnip(monorepo, {
      'packages/app/pnpm-workspace.yaml': 'packages:\n  - plugins/*\n',
    })

    const { stdout } = await project.uncheck(['--only=knip'], { cwd: 'packages/app' })

    expect(report(stdout)).toContain('▶ knip')
  })
})
