import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import process from 'node:process'

import type { Files, Layout, Project } from '../_shared/project'
import { createProject, eachLayout } from '../_shared/project'
import { ECHO, fakeTool, spawnCli, toolArgs } from './fake-tools'

/**
 * A folder of the app with a bit of everything, where the runs happen. oxlint is a fake that prints
 * the files it gets, the only check that runs, so every run shows how the paths resolved.
 */
const AREA = {
  'src/a.ts': '',
  'src/b.ts': '',
  'src/sub/c.ts': '',
  'docs/readme.md': '',
  'app/[id].ts': '',
  'dist/out.js': '',
}

function areaProject(layout: Layout, files: Files = {}, git = true) {
  const project = createProject(layout, {
    tools: [],
    git,
    files: { ...fakeTool('oxlint', ECHO) },
  })
  const area = project.inApp('area')

  project.write(
    Object.fromEntries(
      Object.entries({ ...AREA, ...files }).map(([file, content]) => [`${area}/${file}`, content]),
    ),
  )

  return { project, area }
}

/** The files the fake oxlint got, after its own flag. */
async function resolve(project: Project, cwd: string, paths: string[]) {
  const result = await project.run(['--only=oxlint', ...paths], { cwd })

  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)

  return toolArgs(result.stdout).flatMap((args) =>
    args.filter((arg) => arg !== '--no-error-on-unmatched-pattern'),
  )
}

eachLayout('uncheck <paths> in a $layout repository', ({ layout }) => {
  it('turns files, directories, globs and negations into one file list', async () => {
    const { project, area } = areaProject(layout)

    expect(await resolve(project, area, ['src/a.ts'])).toEqual(['src/a.ts'])
    expect(await resolve(project, area, ['src'])).toEqual(['src/a.ts', 'src/b.ts', 'src/sub/c.ts'])
    expect(await resolve(project, area, ['./src/', 'src/a.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/sub/c.ts',
    ])
    expect(await resolve(project, area, ['src/**/*.ts', '!src/sub'])).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    expect(await resolve(project, area, ['**/*.md'])).toEqual(['docs/readme.md'])
    // An existing path is not read as a glob, so route files with brackets can be named.
    expect(await resolve(project, area, ['app/[id].ts'])).toEqual(['app/[id].ts'])
    expect(await resolve(project, area, ['.'])).toEqual([
      'app/[id].ts',
      'docs/readme.md',
      'src/a.ts',
      'src/b.ts',
      'src/sub/c.ts',
    ])
  })

  it('reports patterns that match nothing and keeps ignored files out unless named', async () => {
    const { project, area } = areaProject(layout)

    const none = await project.run(['--only=oxlint', 'nope.ts', 'src/**/*.tsx', 'dist'], {
      cwd: area,
    })

    expect(none.code).toBe(1)
    expect(none.stdout).toBe(`uncheck in ${project.path(area)}\n`)
    expect(none.stderr).toContain(
      'No files match nope.ts, src/**/*.tsx, dist. Pass --no-error-on-unmatched-pattern to run with whatever matched.',
    )

    const some = await project.run(['--only=oxlint', 'src/a.ts', 'missing/'], { cwd: area })

    expect(some.code).toBe(1)
    expect(some.stderr).toContain('No files match missing/.')
    expect(toolArgs(some.stdout)).toEqual([])

    // An explicitly named file counts even when git ignores it.
    expect(await resolve(project, area, ['dist/out.js'])).toEqual(['dist/out.js'])
  })

  it('runs with whatever matched when told to, and with nothing when nothing did', async () => {
    const { project, area } = areaProject(layout)

    expect(
      await resolve(project, area, [
        '--no-error-on-unmatched-pattern',
        'src/a.ts',
        'missing.ts',
        'nope/**',
      ]),
    ).toEqual(['src/a.ts'])

    const nothing = await project.run(['--no-error-on-unmatched-pattern', 'missing.ts'], {
      cwd: area,
    })

    expect(nothing.code).toBe(0)
    expect(nothing.stdout).toBe(
      `uncheck in ${project.path(area)}\n○ nothing to check, no files match missing.ts\n`,
    )

    // Excluding the folder itself leaves nothing, which is no mistake in a pattern.
    const excluded = await project.run(['!.'], { cwd: area })

    expect(excluded.code).toBe(0)
    expect(excluded.stdout).toBe(
      `uncheck in ${project.path(area)}\n○ nothing to check, no files match !.\n`,
    )
  })

  it('lets globs and exclusions match dot files the way directories include them', async () => {
    const { project, area } = areaProject(layout, {
      '.github/workflows/ci.yml': '',
      '.vscode/settings.json': '',
      'src/.env.ts': '',
    })
    const src = ['src/.env.ts', 'src/a.ts', 'src/b.ts', 'src/sub/c.ts']

    expect(await resolve(project, area, ['**/*.yml'])).toEqual(['.github/workflows/ci.yml'])
    expect(await resolve(project, area, ['src'])).toEqual(src)
    expect(await resolve(project, area, ['src/**'])).toEqual(src)
    expect(await resolve(project, area, ['src/{.,sub}/*.ts'])).toEqual(src)
    expect(await resolve(project, area, ['.', '!**/*.json'])).toEqual([
      '.github/workflows/ci.yml',
      'app/[id].ts',
      'docs/readme.md',
      ...src,
    ])
  })

  it('reads [!x] as any character but x and parentheses literally, as in route groups', async () => {
    const { project, area } = areaProject(layout, {
      'app/(marketing)/page.ts': '',
      'app/marketing/page.ts': '',
    })

    expect(await resolve(project, area, ['src/[!a]*.ts'])).toEqual(['src/b.ts'])
    expect(await resolve(project, area, ['src', '!src/[!a]*.ts'])).toEqual([
      'src/a.ts',
      'src/sub/c.ts',
    ])
    expect(await resolve(project, area, ['app/(marketing)/**'])).toEqual([
      'app/(marketing)/page.ts',
    ])
    expect(await resolve(project, area, ['app', '!app/(marketing)/**'])).toEqual([
      'app/[id].ts',
      'app/marketing/page.ts',
    ])
  })

  it('excludes from everything when only exclusions are given', async () => {
    const { project, area } = areaProject(layout, { '.env.ts': '' })

    expect(await resolve(project, area, ['!src/sub', '!.*'])).toEqual([
      'app/[id].ts',
      'docs/readme.md',
      'src/a.ts',
      'src/b.ts',
    ])
  })

  it('leaves out a linked node_modules that a folder-only ignore rule misses', async () => {
    const { project, area } = areaProject(layout)
    const store = project.path('store')

    project.write({
      '.gitignore': 'node_modules/\ndist/\nstore/\n',
      'store/dep/index.js': '',
    })
    symlinkSync(store, project.path(`${area}/node_modules`))
    symlinkSync(store, project.path(`${area}/src/node_modules`))

    expect(await resolve(project, area, ['.', 'src'])).toEqual([
      'app/[id].ts',
      'docs/readme.md',
      'src/a.ts',
      'src/b.ts',
      'src/sub/c.ts',
    ])
  })

  it('walks the tree outside a git repository', async () => {
    const { project, area } = areaProject(
      layout,
      { '.env.ts': '', 'node_modules/dep/a.ts': '' },
      false,
    )

    expect(await resolve(project, area, ['src', 'dist/**'])).toEqual([
      'dist/out.js',
      'src/a.ts',
      'src/b.ts',
      'src/sub/c.ts',
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'walks past what it cannot read and never into linked folders',
    async () => {
      const { project, area } = areaProject(layout, {}, false)
      const locked = project.path(`${area}/locked`)

      symlinkSync('.', project.path(`${area}/loop`))
      symlinkSync('..', project.path(`${area}/src/up`))
      symlinkSync('gone', project.path(`${area}/src/dangling.ts`))
      execFileSync('mkfifo', [project.path(`${area}/src/pipe`)])
      mkdirSync(locked)
      project.write({ [`${area}/locked/hidden.ts`]: '' })
      chmodSync(locked, 0)

      try {
        // root reads any folder, unless it runs without the capabilities that let it.
        const result = await spawnCli(project, ['--only=oxlint', '.'], {
          cwd: area,
          wrap:
            process.getuid?.() === 0
              ? ['setpriv', '--bounding-set=-dac_override,-dac_read_search']
              : [],
        })

        expect(result.code).toBe(0)
        expect(toolArgs(result.stdout)).toEqual([
          [
            '--no-error-on-unmatched-pattern',
            'app/[id].ts',
            'dist/out.js',
            'docs/readme.md',
            'src/a.ts',
            'src/b.ts',
            'src/sub/c.ts',
          ],
        ])
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )
})
