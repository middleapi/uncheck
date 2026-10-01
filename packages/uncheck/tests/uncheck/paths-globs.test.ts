import type { Project } from '../utils/project'
import { LAYOUTS } from '../utils/project'
import { checkedFiles, listingProject } from './utils'

const ROUTES = [
  '#draft.ts',
  '(group)/page.ts',
  '.env.ts',
  '[id].ts',
  '[slug]/page.ts',
  'about.ts',
  'd.ts',
  'group/page.ts',
  'home.ts',
  'i.ts',
  'nested/.draft.ts',
  'nested/deep.ts',
  'notes.md',
]

describe.each(LAYOUTS)('uncheck with globs in a $name', ({ create, app }) => {
  const routes = (...files: ReadonlyArray<string>) =>
    files.map((file) => `${app}src/routes/${file}`)

  function routesProject() {
    return listingProject(create, {
      ...Object.fromEntries(routes(...ROUTES).map((file) => [file, ''])),
      '.github/workflows/ci.yml': 'on: push\n',
    })
  }

  async function check(
    project: Project,
    patterns: ReadonlyArray<string>,
    cwd?: string,
  ): Promise<string[]> {
    const { exitCode, stdout, stderr } = await project.uncheck(['--only=oxlint', ...patterns], {
      cwd,
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    return checkedFiles(stdout)
  }

  it('matches * within one folder, dot files included', async () => {
    const project = routesProject()

    expect(await check(project, routes('*.ts'))).toEqual(
      routes('#draft.ts', '.env.ts', '[id].ts', 'about.ts', 'd.ts', 'home.ts', 'i.ts'),
    )
  })

  it('matches ** across folders, dot files and dot folders included', async () => {
    const project = routesProject()

    expect(await check(project, routes('**/*.ts'))).toEqual(
      routes(...ROUTES.filter((file) => file.endsWith('.ts'))),
    )
    expect(await check(project, ['**/*.yml'])).toEqual(['.github/workflows/ci.yml'])
  })

  it('matches ? as one character', async () => {
    const project = routesProject()

    expect(await check(project, routes('?.ts'))).toEqual(routes('d.ts', 'i.ts'))
  })

  it('matches [...] as one of the characters and [!...] as any other', async () => {
    const project = routesProject()

    expect(await check(project, routes('[hd]*.ts'))).toEqual(routes('d.ts', 'home.ts'))
    expect(await check(project, routes('[!ah]*.ts'))).toEqual(
      routes('#draft.ts', '.env.ts', '[id].ts', 'd.ts', 'i.ts'),
    )
  })

  it('matches {a,b} as either, and a "." among them as the folder itself', async () => {
    const project = routesProject()

    expect(await check(project, routes('{home,about}.ts'))).toEqual(routes('about.ts', 'home.ts'))
    expect(await check(project, routes('{.,nested}/*.ts'))).toEqual(
      routes(
        '#draft.ts',
        '.env.ts',
        '[id].ts',
        'about.ts',
        'd.ts',
        'home.ts',
        'i.ts',
        'nested/.draft.ts',
        'nested/deep.ts',
      ),
    )
  })

  it('reads (...) literally, as in route groups, and @(a|b) as either', async () => {
    const project = routesProject()

    expect(await check(project, routes('(group)/**'))).toEqual(routes('(group)/page.ts'))
    expect(await check(project, routes('@(home|about).ts'))).toEqual(routes('about.ts', 'home.ts'))
  })

  it('matches a character escaped with \\ literally', async () => {
    const project = routesProject()

    expect(await check(project, routes('\\[id\\].ts', '\\[slug\\]/*'))).toEqual(
      routes('[id].ts', '[slug]/page.ts'),
    )
  })

  it('reads a glob starting with "#" as a glob rather than a comment', async () => {
    const project = routesProject()

    expect(await check(project, ['#*.ts'], `${app}src/routes`)).toEqual(['#draft.ts'])
  })

  it('takes an existing file whose name looks like a glob as that file', async () => {
    const project = routesProject()

    expect(await check(project, routes('[id].ts', '(group)/page.ts'))).toEqual(
      routes('(group)/page.ts', '[id].ts'),
    )

    project.write({ [routes('[id].ts')[0]!]: null })

    expect(await check(project, routes('[id].ts'))).toEqual(routes('d.ts', 'i.ts'))
  })

  it('takes an existing folder whose name looks like a glob as that folder', async () => {
    const project = routesProject()

    expect(await check(project, routes('(group)', '[slug]'))).toEqual(
      routes('(group)/page.ts', '[slug]/page.ts'),
    )
  })
})
