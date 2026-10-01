import type { Project } from '../utils/project'
import { LAYOUTS, report } from '../utils/project'
import { checkedFiles, listingProject } from './utils'

const ROUTES = [
  '#draft.ts',
  '(group)/page.ts',
  '.env.ts',
  '[id].ts',
  'about.ts',
  'd.ts',
  'home.ts',
  'i.ts',
  'nested/deep.ts',
  'nested/more/deeper.ts',
  'settings.json',
]

describe.each(LAYOUTS)('uncheck with exclusions in a $name', ({ create, app }) => {
  const cwd = `${app}src/routes`

  function routesProject(): Project {
    return listingProject(create, Object.fromEntries(ROUTES.map((file) => [`${cwd}/${file}`, ''])))
  }

  async function check(project: Project, ...patterns: ReadonlyArray<string>): Promise<string[]> {
    const { exitCode, stdout, stderr } = await project.uncheck(['--only=oxlint', ...patterns], {
      cwd,
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    return checkedFiles(stdout)
  }

  const without = (...excluded: ReadonlyArray<string>) =>
    ROUTES.filter((file) => !excluded.includes(file))

  it('leaves out a file', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!home.ts', '!./about.ts')).toEqual(
      without('home.ts', 'about.ts'),
    )
  })

  it('leaves out an existing file or folder whose name looks like a glob as that path alone', async () => {
    const project = routesProject()

    expect(await check(project, '.', '![id].ts')).toEqual(without('[id].ts'))
    expect(await check(project, '.', '!(group)')).toEqual(without('(group)/page.ts'))
  })

  it('reads an exclusion naming no existing path as a glob, with \\ escaping', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!\\[id\\].ts')).toEqual(without('[id].ts'))

    project.write({ [`${cwd}/[id].ts`]: null })

    expect(await check(project, '.', '![id].ts')).toEqual(without('[id].ts', 'd.ts', 'i.ts'))
  })

  it('leaves out everything below a directory', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!nested/more')).toEqual(without('nested/more/deeper.ts'))
    expect(await check(project, '.', '!nested/')).toEqual(
      without('nested/deep.ts', 'nested/more/deeper.ts'),
    )
  })

  it('leaves out everything below the folders a glob matches', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!**/nested')).toEqual(
      without('nested/deep.ts', 'nested/more/deeper.ts'),
    )
    expect(await check(project, '.', '!*/more')).toEqual(without('nested/more/deeper.ts'))
  })

  it('leaves out the files a glob matches, dot files included', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!**/*.json', '!.*')).toEqual(
      without('settings.json', '.env.ts'),
    )
    expect(await check(project, '.', '!nested/**/deep*.ts')).toEqual(
      without('nested/deep.ts', 'nested/more/deeper.ts'),
    )
  })

  it('reads (...) literally and [!...] as any other character in an exclusion', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!(group)/**')).toEqual(without('(group)/page.ts'))
    expect(await check(project, '.', '![!ah]*.ts')).toEqual(
      without('#draft.ts', '.env.ts', '[id].ts', 'd.ts', 'i.ts'),
    )
  })

  it('reads an exclusion starting with "#" as a glob rather than a comment', async () => {
    const project = routesProject()

    expect(await check(project, '.', '!#*.ts')).toEqual(without('#draft.ts'))
  })

  it('reads "!!name" as leaving out a file whose name starts with "!"', async () => {
    const project = routesProject().write({ [`${cwd}/!draft.ts`]: '' })

    expect(await check(project, '.')).toEqual(['./!draft.ts', ...ROUTES])
    expect(await check(project, '.', '!!draft.ts')).toEqual(ROUTES)
  })

  it('applies exclusions on their own to everything', async () => {
    const project = routesProject()

    expect(await check(project, '!nested', '!*.json')).toEqual([
      '#draft.ts',
      '(group)/page.ts',
      '.env.ts',
      '[id].ts',
      'about.ts',
      'd.ts',
      'home.ts',
      'i.ts',
    ])
  })

  it('applies exclusions wherever they stand and ignores ones that match nothing', async () => {
    const project = routesProject()

    expect(await check(project, '!home.ts', 'home.ts', 'about.ts', '!missing')).toEqual([
      'about.ts',
    ])
  })

  it('leaves nothing to check after "!."', async () => {
    const project = routesProject()

    const { exitCode, stdout, stderr } = await project.uncheck(['--only=oxlint', '.', '!.'], {
      cwd,
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path(cwd)}`,
      '○ nothing to check, no files match . !.',
    ])
  })
})
