import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Project } from '../utils/project'
import { LAYOUTS, PERMISSIONS_ENFORCED, temporaryDirectory } from '../utils/project'
import { checkedFiles, listingProject } from './utils'

describe.each(LAYOUTS)('uncheck with paths outside git in a $name', ({ create, app }) => {
  const routes = `${app}src/routes`

  function walkedProject(...files: ReadonlyArray<string>): Project {
    return listingProject(
      create,
      Object.fromEntries(files.map((file) => [`${routes}/${file}`, ''])),
      { git: 'none' },
    )
  }

  async function check(project: Project, ...patterns: ReadonlyArray<string>): Promise<string[]> {
    const { exitCode, stdout, stderr } = await project.uncheck(['--only=oxlint', ...patterns])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    return checkedFiles(stdout)
  }

  it('lists the files below a directory, sorted, without dot files or installed packages', async () => {
    const project = walkedProject(
      'home.ts',
      'Zone.ts',
      'nested/deep.ts',
      '.env.ts',
      '.cache/entry.ts',
      'node_modules/dep/index.ts',
      'bower_components/dep/index.ts',
      'jspm_packages/dep/index.ts',
    )
    const listed = [`${routes}/Zone.ts`, `${routes}/home.ts`, `${routes}/nested/deep.ts`]

    expect(await check(project, routes)).toEqual(listed)
    expect(await check(project, `${routes}/**/*.ts`)).toEqual(listed)
  })

  it('lists the files .gitignore would leave out', async () => {
    const project = walkedProject('home.ts', 'dist/bundle.ts').write({
      '.gitignore': 'dist/\n',
      [`${app}dist/out.js`]: '',
    })

    expect(await check(project, routes, `${app}dist/**`)).toEqual([
      `${app}dist/out.js`,
      `${routes}/dist/bundle.ts`,
      `${routes}/home.ts`,
    ])
  })

  it('checks a file the walk skips or a link leaving the project when it is named', async () => {
    const store = temporaryDirectory()
    writeFileSync(join(store, 'vendor.ts'), '')
    const project = walkedProject('.env.ts', 'node_modules/dep/index.ts').link(
      `${routes}/vendor.ts`,
      join(store, 'vendor.ts'),
    )
    const named = [
      `${routes}/.env.ts`,
      `${routes}/node_modules/dep/index.ts`,
      `${routes}/vendor.ts`,
    ]

    expect(await check(project, ...named)).toEqual(named)
  })

  it('lists a linked file inside the project but never enters a linked folder or follows a broken link', async () => {
    const store = temporaryDirectory()
    writeFileSync(join(store, 'vendor.ts'), '')
    const project = walkedProject('home.ts', 'shared/util.ts')
      .link(`${routes}/alias.ts`, 'home.ts')
      .link(`${routes}/vendor.ts`, join(store, 'vendor.ts'))
      .link(`${routes}/broken.ts`, 'missing.ts')
      .link(`${routes}/self.ts`, 'self.ts')
      .link(`${routes}/up`, '..')
      .link(`${routes}/linked`, 'shared')

    expect(await check(project, routes)).toEqual([
      `${routes}/alias.ts`,
      `${routes}/home.ts`,
      `${routes}/shared/util.ts`,
    ])
  })

  it.runIf(PERMISSIONS_ENFORCED)('walks past a folder it cannot read', async () => {
    const project = walkedProject('home.ts', 'locked/secret.ts').chmod(`${routes}/locked`, 0)

    expect(await check(project, routes)).toEqual([`${routes}/home.ts`])
  })
})
