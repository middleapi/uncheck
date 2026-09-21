import { execFileSync } from 'node:child_process'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { fixture } from './fixture'
import { listProjectFiles, resolvePaths } from '../src/files'

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
      Effect.flatMap(Effect.cached(listProjectFiles(dir)), projectFiles => resolvePaths(paths, dir, projectFiles)),
      NodeServices.layer,
    ),
  )
}

describe('resolvePaths', () => {
  it('turns files, directories, globs and negations into one file list', async () => {
    const dir = fixture(project, [])
    execFileSync('git', ['init', '--quiet'], { cwd: dir })

    expect(await resolve(dir, ['src/a.ts'])).toEqual({ files: ['src/a.ts'], unmatched: [] })
    expect(await resolve(dir, ['src'])).toEqual({ files: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts'], unmatched: [] })
    expect(await resolve(dir, ['./src/', 'src/a.ts'])).toEqual({
      files: ['src/a.ts', 'src/b.ts', 'src/sub/c.ts'],
      unmatched: [],
    })
    expect(await resolve(dir, ['src/**/*.ts', '!src/sub'])).toEqual({ files: ['src/a.ts', 'src/b.ts'], unmatched: [] })
    expect(await resolve(dir, ['**/*.md'])).toEqual({ files: ['docs/readme.md'], unmatched: [] })
    // An existing path is not read as a glob, so route files with brackets can be named.
    expect(await resolve(dir, ['app/[id].ts'])).toEqual({ files: ['app/[id].ts'], unmatched: [] })
    expect(await resolve(dir, ['.'])).toEqual({
      files: ['.gitignore', '.prettierignore', 'app/[id].ts', 'docs/readme.md', 'src/a.ts', 'src/b.ts', 'src/sub/c.ts'],
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
    expect(await resolve(dir, ['src/a.ts', 'missing/'])).toEqual({ files: ['src/a.ts'], unmatched: ['missing/'] })
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
})
