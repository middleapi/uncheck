import process from 'node:process'

import { createProject, eachLayout } from '../_shared/project'
import { ECHO, fakeTool, toolArgs } from './fake-tools'

/** The file counts of the `▶ <tool> … [N files]` lines, one per batch. */
function batches(stdout: string, tool: string) {
  return [...stdout.matchAll(new RegExp(`^▶ ${tool} .*\\[(\\d+) files\\]$`, 'gm'))].map((match) =>
    Number(match[1]),
  )
}

eachLayout('uncheck tools in a $layout repository', ({ layout }) => {
  it('splits a long file list into batches every platform can spawn, checking each file', async () => {
    const project = createProject(layout)
    const total = 3000

    project.write({
      ...Object.fromEntries(
        Array.from({ length: total }, (_, index) => [
          project.inApp(`src/features/feature number ${String(index).padStart(4, '0')}.ts`),
          `export const feature${index} = ${index}\n`,
        ]),
      ),
      // Last in the list, so only the last batch sees it.
      [project.inApp('src/features/zz.ts')]: 'var last = 1\nexport { last }\n',
    })

    const result = await project.run(['--skip=tsc', 'src/features'], { cwd: project.appDir })

    expect(result.code).toBe(1)

    for (const tool of ['oxlint', 'oxfmt --check']) {
      const counts = batches(result.stdout, tool)

      expect(counts.length).toBeGreaterThan(1)
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(total + 1)
    }

    expect(result.stdout).toContain('src/features/zz.ts')
    expect(result.stdout).toContain('no-var')
    expect(result.stdout).toContain('✘ 1 of 2 checks failed: oxlint\n')
  })

  it('checks and fixes files whose names start with ! or -', async () => {
    const project = createProject(layout)

    project.write({
      [project.inApp('!notes.ts')]: 'var notes  =  1\nexport { notes }\n',
      [project.inApp('-draft.ts')]: 'export const   draft = 1\n',
    })

    const check = await project.run(['--skip=tsc', '.'], { cwd: project.appDir })

    expect(check.code).toBe(1)
    expect(check.stdout).toContain('!notes.ts')
    expect(check.stdout).toContain('-draft.ts')
    expect(check.stdout).toContain('no-var')
    expect(check.stdout).toContain('✘ 2 of 2 checks failed: oxlint, oxfmt')

    const fix = await project.run(['--skip=tsc', '--fix', '.'], { cwd: project.appDir })

    expect(fix.code).toBe(0)
    expect(project.read(project.inApp('!notes.ts'))).toBe('const notes = 1\nexport { notes }\n')
    expect(project.read(project.inApp('-draft.ts'))).toBe('export const draft = 1\n')
  })

  it('finds a tool in the nearest node_modules that has it, whatever its bin field', async () => {
    const project = createProject(layout, {
      tools: ['oxfmt'],
      files: {
        // A bin that names only another command is no oxlint.
        ...fakeTool('oxlint', ECHO, { other: 'bin.js' }),
        // A package without a bin runs nothing.
        ...fakeTool('sherif', ECHO, null),
        // A single bin is the package's command, whatever its name.
        ...fakeTool('typescript', ECHO, 'bin.js'),
      },
    })

    const top = await project.run(['--skip=oxfmt'], { cwd: project.appDir })

    expect(top.code).toBe(0)
    expect(top.stdout).toContain('○ sherif skipped, not installed\n')
    expect(top.stdout).toContain('○ oxlint skipped, not installed\n')
    expect(top.stdout).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(toolArgs(top.stdout)).toEqual([['-p', 'tsconfig.json', '--noEmit']])

    // An unreadable manifest is passed over for the next folder up.
    project.write({ [project.inApp('src/node_modules/oxfmt/package.json')]: '{ "name": ' })

    const nested = await project.run(['--only=oxfmt'], { cwd: project.inApp('src') })

    expect(nested.code).toBe(0)
    expect(nested.stdout).toContain('▶ oxfmt --check\n')
    expect(nested.stdout).toContain('✔ oxfmt passed')
  })
})

describe('uncheck tools under Yarn PnP', () => {
  it.skipIf(process.platform === 'win32')(
    'asks the PnP resolver of each folder up the tree, then its node_modules',
    async () => {
      const project = createProject('monorepo', {
        tools: ['oxfmt'],
        files: {
          ...fakeTool('oxlint', ECHO, { oxlint: 'bin.js' }, '.yarn/cache'),
          // The resolver Yarn loads into every process it starts, knowing oxlint only from the top.
          '.pnp.cjs': [
            "const Module = require('node:module')",
            "const path = require('node:path')",
            '',
            "process.versions.pnp = '3'",
            'const resolveFilename = Module._resolveFilename',
            'Module._resolveFilename = function (request, parent, ...rest) {',
            "  if (request === 'oxlint/package.json' && parent.filename === path.join(__dirname, 'package.json')) {",
            "    return path.join(__dirname, '.yarn/cache/oxlint/package.json')",
            '  }',
            '  return resolveFilename.call(this, request, parent, ...rest)',
            '}',
            '',
          ].join('\n'),
        },
      })

      const result = await project.run(['--skip=tsc'], {
        cwd: 'packages/app',
        env: { NODE_OPTIONS: `--require ${project.path('.pnp.cjs')}` },
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('○ sherif skipped, not installed\n')
      expect(toolArgs(result.stdout)).toEqual([[]])
      // oxfmt is no package the resolver knows, so it comes from node_modules.
      expect(result.stdout).toContain('▶ oxfmt --check\n')
      expect(result.stdout).toContain('✔ all checks passed (oxlint, oxfmt)')
    },
  )
})
