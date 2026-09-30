import { createProject, eachLayout } from '../_shared/project'
import type { Files, Layout } from '../_shared/project'
import { NOT_COVERED, runPlan } from './tsc-plan'

const compilerOptions = {
  strict: true,
  module: 'esnext',
  moduleResolution: 'bundler',
  types: [],
}

const standalone = { compilerOptions: { ...compilerOptions, noEmit: true }, include: ['src'] }

function composite(references: ReadonlyArray<string> = []) {
  return {
    compilerOptions: {
      ...compilerOptions,
      composite: true,
      emitDeclarationOnly: true,
      outDir: 'dist',
      rootDir: 'src',
    },
    references: references.map((path) => ({ path })),
    include: ['src'],
  }
}

const BROKEN = 'export const answer: number = "42"\n'

/**
 * A reference graph next to standalone projects, in the shape each layout has them: workspace
 * packages that reference each other, or a solution-style tsconfig.json splitting one package.
 */
const GRAPHS = {
  single: {
    files: {
      'tsconfig.json': {
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      },
      'tsconfig.app.json': composite(),
      'tsconfig.node.json': {
        compilerOptions: { ...composite().compilerOptions, outDir: 'dist/node', rootDir: '.' },
        include: ['vite.config.ts'],
      },
      'vite.config.ts': 'export default {}\n',
      'scripts/tsconfig.json': standalone,
      'scripts/src/hello.ts': "export const greeting: string = 'hi'\n",
    },
    plan: '▶ tsc -b tsconfig.json\n▶ tsc -p scripts/tsconfig.json --noEmit\n',
    broken: 'src/math.ts',
    scoped: { path: 'scripts/src/hello.ts', plan: '▶ tsc -p scripts/tsconfig.json --noEmit\n' },
    inside: { path: 'src/index.ts', plan: '▶ tsc -b tsconfig.json\n' },
  },
  monorepo: {
    files: {
      'tsconfig.json': { ...standalone, include: ['scripts'] },
      'scripts/hello.ts': "export const greeting: string = 'hi'\n",
      'packages/lib/tsconfig.json': composite(),
      'packages/app/tsconfig.json': composite(['../lib']),
      'tools/tsconfig.json': standalone,
      'tools/src/index.ts': 'export const tool: number = 1\n',
    },
    plan: '▶ tsc -b packages/app/tsconfig.json\n▶ tsc -p tools/tsconfig.json --noEmit\n▶ tsc -p tsconfig.json --noEmit\n',
    broken: 'packages/lib/src/index.ts',
    scoped: { path: 'packages/app', plan: '▶ tsc -b packages/app/tsconfig.json\n' },
    inside: { path: 'src/index.ts', plan: '▶ tsc -b tsconfig.json\n' },
  },
} satisfies Record<Layout, unknown>

/** Three standalone projects in path order, the middle one broken. */
const STANDALONE: Record<Layout, { files: Files; order: ReadonlyArray<string>; broken: string }> = {
  single: {
    files: {
      'scripts/tsconfig.json': standalone,
      'scripts/src/index.ts': 'export const a: number = 1\n',
      'tests/tsconfig.json': standalone,
      'tests/src/index.ts': BROKEN,
    },
    order: ['scripts/tsconfig.json', 'tests/tsconfig.json', 'tsconfig.json'],
    broken: 'tests/src/index.ts',
  },
  monorepo: {
    files: {
      'packages/lib/src/index.ts': BROKEN,
      'packages/util/tsconfig.json': standalone,
      'packages/util/src/index.ts': 'export const c: number = 3\n',
    },
    order: [
      'packages/app/tsconfig.json',
      'packages/lib/tsconfig.json',
      'packages/util/tsconfig.json',
    ],
    broken: 'packages/lib/src/index.ts',
  },
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

eachLayout('$layout', ({ layout }) => {
  it('builds referenced projects with tsc -b before checking standalone ones with tsc -p, narrowed to the given paths', async () => {
    const graph = GRAPHS[layout]
    const project = createProject(layout, { tools: ['typescript'], files: graph.files })

    const all = await runPlan(project, [], '')

    expect(all.result.code).toBe(0)
    expect(all.result.stdout).toContain(graph.plan)
    expect(all.result.stdout).toContain('✔ all checks passed (tsc)\n')

    const scoped = await runPlan(project, [graph.scoped.path], '')

    expect(scoped.result.code).toBe(0)
    expect(scoped.result.stdout).toContain(`${graph.scoped.plan}✔ tsc passed`)
    expect(scoped.tsc).toHaveLength(1)

    // As a hook in the package runs it.
    const inside = await runPlan(project, [graph.inside.path], project.appDir)

    expect(inside.result.stdout).toContain(`${graph.inside.plan}✔ tsc passed`)

    project.write({ [graph.broken]: BROKEN })

    const broken = await runPlan(project, [], '')

    expect(broken.result.code).toBe(1)
    expect(broken.result.stdout).toContain(graph.plan.split('\n')[0])
    expect(broken.result.stdout).toContain(`${graph.broken}(1,14): error TS2322`)
    expect(broken.result.stdout).toContain('✘ 1 of 1 checks failed: tsc')

    const docs = await runPlan(project, ['README.md'], '')

    expect(docs.tsc).toBe(NOT_COVERED)
  })

  it('checks standalone projects side by side but prints their output in plan order', async () => {
    const { files, order, broken } = STANDALONE[layout]
    const project = createProject(layout, { tools: ['typescript'], files })

    const { result } = await runPlan(project, [], '')

    expect(result.code).toBe(1)
    expect(result.stdout).toMatch(
      new RegExp(
        `▶ tsc -p ${escape(order[0]!)} --noEmit\\n▶ tsc -p ${escape(order[1]!)} --noEmit\\n${escape(broken)}[^▶]*TS2322[^▶]*▶ tsc -p ${escape(order[2]!)} --noEmit\\n✘ tsc failed`,
      ),
    )
  })

  it('discovers tsconfig files through git so ignored folders are skipped', async () => {
    const files = {
      '.gitignore': 'node_modules\nignored\n',
      'ignored/tsconfig.json': standalone,
      'ignored/src/index.ts': BROKEN,
    }

    const walked = await runPlan(
      createProject(layout, { tools: ['typescript'], git: false, files }),
      [],
      '',
    )

    expect(walked.result.code).toBe(1)
    expect(walked.result.stdout).toContain('▶ tsc -p ignored/tsconfig.json --noEmit\n')

    const tracked = await runPlan(createProject(layout, { tools: ['typescript'], files }), [], '')

    expect(tracked.result.code).toBe(0)
    expect(tracked.result.stdout).not.toContain('ignored')
  })

  it('leaves out a tracked tsconfig.json deleted from the working tree', async () => {
    const project = createProject(layout, { tools: ['typescript'] })

    project.remove(project.inApp('tsconfig.json'))

    expect((await runPlan(project, [], '')).tsc).toEqual(
      layout === 'single' ? 'no tsconfig.json found' : ['-p packages/lib/tsconfig.json --noEmit'],
    )
  })

  it('fails when a tsconfig.json exists but typescript is not installed', async () => {
    const project = createProject(layout, { tools: [] })

    const missing = await runPlan(project, [], '')
    const count = layout === 'single' ? 1 : 2

    expect(missing.result.code).toBe(1)
    expect(missing.result.stdout).toContain(
      `✘ tsc found ${count} tsconfig.json but typescript is not installed\n`,
    )

    // Only the selected projects count, and nothing covered is nothing to fail on.
    const [scoped, docs] = await Promise.all([
      runPlan(project, [project.inApp('src/index.ts')], ''),
      runPlan(project, ['package.json'], ''),
    ])

    expect(scoped.tsc).toBe('found 1 tsconfig.json but typescript is not installed')
    expect(docs.tsc).toBe(NOT_COVERED)

    project.remove(project.inApp('tsconfig.json'))
    project.remove('packages/lib/tsconfig.json')

    expect((await runPlan(project, [], '')).tsc).toBe('no tsconfig.json found')
  })
})
