import { createProject } from '../../_shared/project'
import { CLAUDE_STOP, hookOf, sh } from '../shell'

const BROKEN = 'export const   answer: string = 1\n'
const FORMATTED = 'export const answer: string = 1\n'

it('runs a hook installed in a monorepo package on that package, wherever the agent is', async () => {
  const project = createProject('monorepo')

  await project.run(['hooks', 'install', 'claude', 'cursor'], { cwd: 'packages/app' })

  const hooks = {
    claude: hookOf(project, 'claude', 'packages/app'),
    cursor: hookOf(project, 'cursor', 'packages/app'),
  }

  expect(hooks.claude).toBe('npx --no uncheck hooks run --fix --dir=packages/app')

  project.write({
    'packages/app/src/index.ts': BROKEN,
    'packages/lib/src/index.ts': 'export const   lib = 1\n',
  })

  for (const cwd of ['packages/app', 'packages/lib', '.']) {
    const { code, stdout, stderr } = await sh(project, hooks.claude, { cwd, stdin: CLAUDE_STOP })

    expect(code).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toContain(`uncheck in ${project.root}/packages/app\n`)
    expect(stderr).toContain(
      '▶ oxfmt --no-error-on-unmatched-pattern .claude/settings.json .cursor/hooks.json src/index.ts\n',
    )
    expect(stderr).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(stderr).toContain('TS2322')
    expect(stderr).not.toContain('lib')
  }

  expect(project.read('packages/app/src/index.ts')).toBe(FORMATTED)
  expect(project.read('packages/lib/src/index.ts')).toBe('export const   lib = 1\n')

  const cursor = await sh(project, hooks.cursor, {
    cwd: 'packages/lib',
    stdin: JSON.stringify({ hook_event_name: 'stop', status: 'completed', loop_count: 1 }),
  })

  expect(cursor.code).toBe(0)
  expect(cursor.stdout).toBe('')
  expect(cursor.stderr).toContain('TS2322')
})

it('runs a hook installed through pnpm', async () => {
  const project = createProject('single', {
    files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
  })

  await project.run(['hooks', 'install', 'claude'])

  const claude = hookOf(project, 'claude')

  expect(claude).toBe('pnpm exec uncheck hooks run --fix')

  project.write({ 'src/index.ts': BROKEN })

  const { code, stderr } = await sh(project, claude, { cwd: 'src', stdin: CLAUDE_STOP })

  expect(code).toBe(2)
  expect(stderr).toContain('TS2322')
  expect(project.read('src/index.ts')).toBe(FORMATTED)
})
