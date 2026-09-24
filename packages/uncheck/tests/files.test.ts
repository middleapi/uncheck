import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { existingFiles, listProjectFiles, resolvePaths } from '../src/files'
import { fixture } from './fixture'

const project = {
  '.gitignore': 'node_modules\ndist\n',
  'src/a.ts': '',
  'src/b.ts': '',
  'src/sub/c.ts': '',
  'docs/readme.md': '',
  'app/[id].ts': '',
  'dist/out.js': '',
}

function resolve(dir: string, paths: string[]) {
  return Effect.runPromise(
    Effect.provide(
      Effect.flatMap(Effect.cached(listProjectFiles(dir)), (projectFiles) =>
        resolvePaths(paths, dir, projectFiles),
      ),
      NodeServices.layer,
    ),
  )
}

describe('resolvePaths', () => {
  it('turns files, directories, globs and negations into one file list', async () => {
    const dir = fixture(project, [])
    execFileSync('git', ['init', '--quiet'], { cwd: dir })

    expect(await resolve(dir, ['src/a.ts'])).toEqual({ files: ['src/a.ts'], unmatched: [] })
    expect(await resolve(dir, ['src'])).toEqual({
      files: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts'],
      unmatched: [],
    })
    expect(await resolve(dir, ['./src/', 'src/a.ts'])).toEqual({
      files: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts'],
      unmatched: [],
    })
    expect(await resolve(dir, ['src/**/*.ts', '!src/sub'])).toEqual({
      files: ['src/a.ts', 'src/b.ts'],
      unmatched: [],
    })
    expect(await resolve(dir, ['**/*.md'])).toEqual({ files: ['docs/readme.md'], unmatched: [] })
    // An existing path is not read as a glob, so route files with brackets can be named.
    expect(await resolve(dir, ['app/[id].ts'])).toEqual({ files: ['app/[id].ts'], unmatched: [] })
    expect(await resolve(dir, ['.'])).toEqual({
      files: [
        '.gitignore',
        '.prettierignore',
        'app/[id].ts',
        'docs/readme.md',
        'src/a.ts',
        'src/b.ts',
        'src/sub/c.ts',
      ],
      unmatched: [],
    })
  })

  it('reports patterns that match nothing and keeps ignored files out unless named', async () => {
    const dir = fixture(project, [])
    execFileSync('git', ['init', '--quiet'], { cwd: dir })

    expect(await resolve(dir, ['nope.ts', 'src/**/*.tsx', 'dist'])).toEqual({
      files: [],
      unmatched: ['nope.ts', 'src/**/*.tsx', 'dist'],
    })
    expect(await resolve(dir, ['src/a.ts', 'missing/'])).toEqual({
      files: ['src/a.ts'],
      unmatched: ['missing/'],
    })
    // An explicitly named file counts even when git ignores it.
    expect(await resolve(dir, ['dist/out.js'])).toEqual({ files: ['dist/out.js'], unmatched: [] })
  })

  it('walks the tree outside a git repository', async () => {
    const dir = fixture(project, [])

    expect(await resolve(dir, ['src', 'dist/**'])).toEqual({
      files: ['dist/out.js', 'src/a.ts', 'src/b.ts', 'src/sub/c.ts'],
      unmatched: [],
    })
  })

  it('walks past folders it cannot read and never into linked folders', async () => {
    const dir = fixture(project, [])
    symlinkSync('.', join(dir, 'loop'))
    symlinkSync('..', join(dir, 'src/up'))
    const locked = join(dir, 'locked')
    mkdirSync(locked)

    if (process.platform !== 'win32') {
      chmodSync(locked, 0)
    }

    try {
      expect(await resolve(dir, ['.'])).toEqual({
        files: [
          'app/[id].ts',
          'dist/out.js',
          'docs/readme.md',
          'src/a.ts',
          'src/b.ts',
          'src/sub/c.ts',
        ],
        unmatched: [],
      })
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('lets globs and exclusions match dot files the way directories include them', async () => {
    const dir = fixture(
      {
        ...project,
        '.github/workflows/ci.yml': '',
        '.vscode/settings.json': '',
        'package.json': '{}',
        'src/.env.ts': '',
      },
      [],
    )
    execFileSync('git', ['init', '--quiet'], { cwd: dir })

    expect(await resolve(dir, ['**/*.yml'])).toEqual({
      files: ['.github/workflows/ci.yml'],
      unmatched: [],
    })
    expect(await resolve(dir, ['src/**'])).toEqual(await resolve(dir, ['src']))
    expect(await resolve(dir, ['src/{.,sub}/*.ts'])).toEqual(await resolve(dir, ['src']))
    expect((await resolve(dir, ['.', '!**/*.json'])).files).not.toContain('.vscode/settings.json')
  })

  it('reads [!x] as any character but x and parentheses literally, as in route groups', async () => {
    const dir = fixture(
      { ...project, 'app/(marketing)/page.ts': '', 'app/marketing/page.ts': '' },
      [],
    )
    execFileSync('git', ['init', '--quiet'], { cwd: dir })

    expect(await resolve(dir, ['src/[!a]*.ts'])).toEqual({ files: ['src/b.ts'], unmatched: [] })
    expect(await resolve(dir, ['src', '!src/[!a]*.ts'])).toEqual({
      files: ['src/a.ts', 'src/sub/c.ts'],
      unmatched: [],
    })
    expect(await resolve(dir, ['app/(marketing)/**'])).toEqual({
      files: ['app/(marketing)/page.ts'],
      unmatched: [],
    })
    expect((await resolve(dir, ['app', '!app/(marketing)/**'])).files).toEqual([
      'app/[id].ts',
      'app/marketing/page.ts',
    ])
  })

  it('leaves out a linked node_modules that a folder-only ignore rule misses', async () => {
    const store = fixture({ 'dep/index.js': '' }, [])
    const dir = fixture({ ...project, '.gitignore': 'node_modules/\ndist/\n' }, [])
    execFileSync('git', ['init', '--quiet'], { cwd: dir })
    symlinkSync(store, join(dir, 'node_modules'))
    symlinkSync(store, join(dir, 'src/node_modules'))

    expect((await resolve(dir, ['.', 'src'])).files).toEqual([
      '.gitignore',
      '.prettierignore',
      'app/[id].ts',
      'docs/readme.md',
      'src/a.ts',
      'src/b.ts',
      'src/sub/c.ts',
    ])
  })

  it('excludes from everything when only exclusions are given', async () => {
    const dir = fixture(project, [])
    execFileSync('git', ['init', '--quiet'], { cwd: dir })

    expect(await resolve(dir, ['!src/sub', '!.*'])).toEqual({
      files: ['app/[id].ts', 'docs/readme.md', 'src/a.ts', 'src/b.ts'],
      unmatched: [],
    })
  })
})

describe('existingFiles', () => {
  it('takes file names as they are and drops the ones that are gone', async () => {
    const dir = fixture({ ...project, '!notes.ts': '', '-draft.ts': '' }, [])

    expect(
      await Effect.runPromise(
        Effect.provide(
          existingFiles(['!notes.ts', '-draft.ts', 'app/[id].ts', 'app/i.ts', 'src'], dir),
          NodeServices.layer,
        ),
      ),
    ).toEqual(['!notes.ts', '-draft.ts', 'app/[id].ts'])
  })
})
