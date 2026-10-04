import { git, LAYOUTS, project, report, singleRepo } from '../utils/project'
import { selectedReport } from './utils'

const OTHERS_NOT_SELECTED = [
  '○ sherif skipped, not selected by --only',
  '○ oxlint skipped, not selected by --only',
  '○ oxfmt skipped, not selected by --only',
  '○ tsc skipped, not selected by --only',
]

const ORPHAN = 'export const orphan = 1;\n'

function fallowSkipped(dir: string, reason: string): string[] {
  return [
    `uncheck in ${dir}`,
    ...OTHERS_NOT_SELECTED,
    `○ fallow skipped, ${reason}`,
    `✘ nothing to check: sherif not selected by --only, oxlint not selected by --only, oxfmt not selected by --only, tsc not selected by --only, fallow ${reason}`,
  ]
}

describe.each(LAYOUTS)('uncheck fallow in a $name', ({ create, app }) => {
  // From a folder of the package to the root of the project.
  const up = app === '' ? '..' : '../../..'

  it('reports the unused code of the whole project', async () => {
    const project = create({ [`${app}src/orphan.ts`]: ORPHAN }, { tools: ['fallow'] })

    const { exitCode, stdout } = await project.uncheck(['--only=fallow'])

    expect(stdout).toContain(`Unused files (1)\n  ${app}src/orphan.ts\n`)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...OTHERS_NOT_SELECTED,
      '▶ fallow dead-code --quiet',
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })

  it('passes what the fallow config only warns about, and never applies the fixes of fallow', async () => {
    // fallow warns that nothing imports sherif and uncheck, and `fallow fix` would remove them.
    const project = create({}, { tools: ['fallow'] })
    const manifest = project.read('package.json')

    const { exitCode, stdout } = await project.uncheck(['--fix', '--only=fallow'])

    expect(stdout).toContain('Unused devDependencies (2)\n  sherif\n  uncheck\n')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ fallow dead-code --quiet',
      '✔ fallow passed',
      '✔ all checks passed (fallow)',
    ])
    expect(project.read('package.json')).toBe(manifest)
    expect(exitCode).toBe(0)
  })

  it('runs from the root of the project in a folder, and reports only on that folder', async () => {
    const project = create(
      { [`${app}src/orphan.ts`]: ORPHAN, [`${app}lib/orphan.ts`]: ORPHAN },
      { tools: ['fallow'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--only=fallow'], { cwd: `${app}src` })

    expect(stdout).toContain(`Unused files (1)\n  ${app}src/orphan.ts\n`)
    expect(stdout).not.toContain('Unused devDependencies')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      `▶ fallow dead-code --quiet --root=${up} .`,
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })

  it('reports only on the given files, from the root of the project', async () => {
    const project = create({ [`${app}src/orphan.ts`]: ORPHAN }, { tools: ['fallow'] })

    const index = await project.uncheck(['--only=fallow', `${app}src/index.ts`])

    expect(selectedReport(index.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ fallow dead-code --quiet --file=${app}src/index.ts`,
      '✔ fallow passed',
      '✔ all checks passed (fallow)',
    ])
    expect(index.exitCode).toBe(0)

    const folder = await project.uncheck(['--only=fallow', 'orphan.ts', 'index.ts'], {
      cwd: `${app}src`,
    })

    expect(folder.stdout).toContain(`Unused files (1)\n  ${app}src/orphan.ts\n`)
    expect(selectedReport(folder.stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      `▶ fallow dead-code --quiet --root=${up} --file=${app}src/index.ts --file=${app}src/orphan.ts`,
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(folder.exitCode).toBe(1)
  })

  it('hands fallow file names starting with - or ! as files', async () => {
    const project = create(
      { [`${app}-draft.ts`]: ORPHAN, [`${app}!notes.ts`]: ORPHAN },
      { tools: ['fallow'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--only=fallow', '*.ts'], {
      cwd: app === '' ? '.' : app,
    })

    expect(stdout).toContain(`Unused files (2)\n  ${app}!notes.ts\n  ${app}-draft.ts\n`)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, '.')}`,
      app === ''
        ? '▶ fallow dead-code --quiet --file=!notes.ts --file=-draft.ts'
        : `▶ fallow dead-code --quiet --root=../.. --file=${app}!notes.ts --file=${app}-draft.ts`,
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })

  it('splits a file list too long for one command line, counting the --file= of each', async () => {
    // 300 of these names fit on one command line, but not with --file= before each of them.
    const name = (index: number) =>
      `${app}generated/${'x'.repeat(80 - app.length)}${String(index).padStart(4, '0')}.ts`
    const files = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [name(index), ORPHAN]),
    )
    const project = create(files, { tools: ['fallow'] })

    const { exitCode, stdout } = await project.uncheck(['--only=fallow', `${app}generated`])

    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ fallow dead-code --quiet [280 files]',
      '▶ fallow dead-code --quiet [20 files]',
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })

  it('shows the errors fallow reports, such as an invalid config', async () => {
    const project = create(
      { '.fallowrc.json': { rules: { 'unused-files': 'never' } } },
      { tools: ['fallow'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--only=fallow'])

    expect(stdout).toContain('unknown variant `never`')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ fallow dead-code --quiet',
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })

  it('skips fallow when it is not installed, unless it is required', async () => {
    const project = create()

    const skipped = await project.uncheck(['--only=fallow'])

    expect(report(skipped.stdout)).toEqual(fallowSkipped(project.dir, 'not installed'))
    expect(skipped.exitCode).toBe(1)

    const required = await project.uncheck(['--require=fallow'])

    expect(report(required.stdout)).toContain('✘ fallow not installed')
    expect(report(required.stdout).at(-1)).toMatch(/^✘ 1 of \d checks failed: fallow$/)
    expect(required.exitCode).toBe(1)
  })
})

describe('uncheck fallow in a monorepo package', () => {
  const app = LAYOUTS[1]!.app

  it('runs at the workspace root, with the entry points and the config there', async () => {
    const project = LAYOUTS[1]!.create(
      {
        // Only the root knows the script, so fallow run in the package takes it for unused.
        'package.json': {
          name: 'monorepo',
          private: true,
          scripts: { seed: `node ${app}scripts/seed.js` },
        },
        [`${app}scripts/seed.js`]: 'console.log("seeded");\n',
        [`${app}src/orphan.ts`]: ORPHAN,
        [`${app}src/generated.ts`]: ORPHAN,
        '.fallowrc.json': { ignorePatterns: [`${app}src/generated.ts`] },
      },
      { tools: ['fallow'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--only=fallow'], { cwd: app })

    expect(stdout).toContain(`Unused files (1)\n  ${app}src/orphan.ts\n`)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, '.')}`,
      '▶ fallow dead-code --quiet --root=../.. .',
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })
})

describe('uncheck fallow finding the root of the project', () => {
  it('runs in a package that is no workspace member from that package', async () => {
    const project = singleRepo(
      {
        'tools/gen/package.json': { name: 'gen', private: true, main: 'index.js' },
        'tools/gen/index.js': 'console.log("generated");\n',
        'tools/gen/orphan.js': ORPHAN,
      },
      { tools: ['fallow'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--only=fallow'], { cwd: 'tools/gen' })

    expect(stdout).toContain('Unused files (1)\n  orphan.js\n')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path('tools/gen')}`,
      '▶ fallow dead-code --quiet',
      '✘ fallow failed',
      '✘ 1 of 1 checks failed: fallow',
    ])
    expect(exitCode).toBe(1)
  })

  it('skips fallow without a package.json in the repository', async () => {
    const created = project({ 'src/index.ts': ORPHAN }, { tools: ['fallow'] })

    const { exitCode, stdout } = await created.uncheck(['--only=fallow'], { cwd: 'src' })

    expect(report(stdout)).toEqual(fallowSkipped(created.path('src'), 'no package.json found'))
    expect(exitCode).toBe(1)
  })

  it('looks for a package.json no further up than the repository', async () => {
    const created = project(
      { 'package.json': { name: 'outer', private: true }, 'nested/index.ts': ORPHAN },
      { tools: ['fallow'], git: 'none' },
    )

    git(created.path('nested'), ['init', '--quiet'])

    const { exitCode, stdout } = await created.uncheck(['--only=fallow'], { cwd: 'nested' })

    expect(report(stdout)).toEqual(fallowSkipped(created.path('nested'), 'no package.json found'))
    expect(exitCode).toBe(1)
  })

  it('looks for a package.json only in the folder it runs in outside git', async () => {
    const created = singleRepo({}, { tools: ['fallow'], git: 'none' })

    const { exitCode, stdout } = await created.uncheck(['--only=fallow'], { cwd: 'src' })

    expect(report(stdout)).toEqual(fallowSkipped(created.path('src'), 'no package.json found'))
    expect(exitCode).toBe(1)
  })
})
