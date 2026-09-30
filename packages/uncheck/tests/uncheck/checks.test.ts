import process from 'node:process'

import type { Layout } from '../_shared/project'
import { createProject, eachLayout } from '../_shared/project'
import { fakeTool } from './fake-tools'

/** How sherif shows up in a run at the top: a monorepo is a workspace, a single package is not. */
function sherifAtTop(layout: Layout, fix = false) {
  return layout === 'monorepo'
    ? `▶ sherif${fix ? ' --fix --select=highest' : ''}\n`
    : '○ sherif skipped, not a workspace root\n'
}

eachLayout('uncheck in a $layout repository', ({ layout }) => {
  const checks = layout === 'monorepo' ? 'sherif, oxlint, oxfmt, tsc' : 'oxlint, oxfmt, tsc'
  const count = layout === 'monorepo' ? 4 : 3

  it('reports oxlint and oxfmt failures, fixes them with --fix, then passes', async () => {
    const project = createProject(layout)

    project.write({
      [project.inApp('src/legacy.ts')]: 'var count = 1\nexport { count }\n',
      [project.inApp('src/ugly.ts')]: 'export const   ugly = {a:1,\n b:2}\n',
    })

    const check = await project.run()

    expect(check.code).toBe(1)
    expect(check.stdout).toContain(`uncheck in ${project.root}\n${sherifAtTop(layout)}`)
    expect(check.stdout).toContain('no-var')
    expect(check.stdout).toContain(project.inApp('src/ugly.ts'))
    expect(check.stdout).toContain(`✘ 2 of ${count} checks failed: oxlint, oxfmt`)
    expect(check.stdout).toContain('rerun with `--fix` to apply oxlint and oxfmt fixes')

    const fix = await project.run(['--fix'])

    expect(fix.code).toBe(0)
    expect(fix.stdout).toContain(sherifAtTop(layout, true))
    expect(fix.stdout).toContain('▶ oxlint --fix\n')
    expect(fix.stdout).toContain('▶ oxfmt\n')
    expect(project.read(project.inApp('src/legacy.ts'))).toBe('const count = 1\nexport { count }\n')
    expect(project.read(project.inApp('src/ugly.ts'))).toBe('export const ugly = { a: 1, b: 2 }\n')

    const clean = await project.run()

    expect(clean.code).toBe(0)
    expect(clean.stdout.startsWith(`uncheck in ${project.root}\n${sherifAtTop(layout)}`)).toBe(true)
    expect(clean.stdout).toContain('▶ oxlint\n')
    expect(clean.stdout).toContain('▶ oxfmt --check\n')
    expect(clean.stdout).toContain(
      layout === 'monorepo'
        ? '▶ tsc -p packages/app/tsconfig.json --noEmit\n▶ tsc -p packages/lib/tsconfig.json --noEmit\n✔ tsc passed'
        : '▶ tsc -p tsconfig.json --noEmit\n✔ tsc passed',
    )
    expect(clean.stdout).toMatch(/✔ oxlint passed \d+ms\n/)
    expect(clean.stdout).toContain(`\n✔ all checks passed (${checks})\n`)
  })

  it('checks the package it runs in', async () => {
    const project = createProject(layout)

    const result = await project.run([], { cwd: project.appDir })

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(
      new RegExp(
        `^uncheck in ${project.app}\\n○ sherif skipped, not a workspace root\\n▶ oxlint\\n`,
      ),
    )
    expect(result.stdout).toContain('▶ tsc -p tsconfig.json --noEmit\n')
    expect(result.stdout).toContain('✔ all checks passed (oxlint, oxfmt, tsc)')
  })

  it('fails a type error without offering fixes it cannot make', async () => {
    const project = createProject(layout)

    project.write({
      [project.inApp('src/wrong.ts')]: "export const wrong: number = 'x'\n",
    })

    const check = await project.run()

    expect(check.code).toBe(1)
    expect(check.stdout).toContain(`${project.inApp('src/wrong.ts')}`)
    expect(check.stdout).toContain('TS2322')
    expect(check.stdout).toContain('✘ tsc failed')
    expect(check.stdout).toContain(`✘ 1 of ${count} checks failed: tsc\n`)
    expect(check.stdout).not.toContain('rerun with')

    project.write({ [project.inApp('src/legacy.ts')]: 'var count = 1\nexport { count }\n' })

    // With --fix, a check that still fails gets no hint to fix it.
    const fix = await project.run(['--fix'])

    expect(fix.code).toBe(1)
    expect(fix.stdout).toContain(`✘ 1 of ${count} checks failed: tsc\n`)
    expect(fix.stdout).not.toContain('rerun with')
    expect(project.read(project.inApp('src/legacy.ts'))).toBe('const count = 1\nexport { count }\n')
  })

  it('forwards the given paths to oxlint and oxfmt', async () => {
    const project = createProject(layout)

    project.write({
      [project.inApp('src/legacy.ts')]: 'var count = 1\nexport { count }\n',
      [project.inApp('README.md')]: '# App\n',
    })

    const scoped = await project.run([project.inApp('src/index.ts')])

    expect(scoped.code).toBe(0)
    expect(scoped.stdout).not.toContain('no-var')
    expect(scoped.stdout).toContain(
      `▶ oxlint --no-error-on-unmatched-pattern ${project.inApp('src/index.ts')}\n`,
    )
    expect(scoped.stdout).toContain(
      `▶ oxfmt --check --no-error-on-unmatched-pattern ${project.inApp('src/index.ts')}\n`,
    )
    expect(scoped.stdout).toContain('○ sherif skipped, no package.json among the given files\n')

    const fix = await project.run(['--fix', 'src/index.ts', 'src/legacy.ts'], {
      cwd: project.appDir,
    })

    expect(fix.code).toBe(0)
    expect(fix.stdout).toContain(
      '▶ oxlint --fix --no-error-on-unmatched-pattern src/index.ts src/legacy.ts\n',
    )
    expect(fix.stdout).toContain(
      '▶ oxfmt --no-error-on-unmatched-pattern src/index.ts src/legacy.ts\n',
    )
    expect(project.read(project.inApp('src/legacy.ts'))).toBe('const count = 1\nexport { count }\n')

    const all = await project.run(['.'])

    expect(all.code).toBe(0)
    expect(all.stdout).toMatch(/▶ oxlint --no-error-on-unmatched-pattern \[\d+ files\]\n/)
    expect(all.stdout).toMatch(/▶ oxfmt --check --no-error-on-unmatched-pattern \[\d+ files\]\n/)

    // Files no tool handles are no failure, and tsc has nothing to do with them.
    const docs = await project.run(['README.md'], { cwd: project.appDir })

    expect(docs.code).toBe(0)
    expect(docs.stdout).toContain('▶ oxlint --no-error-on-unmatched-pattern README.md\n')
    expect(docs.stdout).toContain('▶ oxfmt --check --no-error-on-unmatched-pattern README.md\n')
    expect(docs.stdout).toContain('○ tsc skipped, no tsconfig.json covers the given files\n')
    expect(docs.stdout).toContain('✔ all checks passed (oxlint, oxfmt)')
  })

  it('fails when there is nothing to check', async () => {
    const project = createProject(layout, {
      tools: [],
      files: {
        'tsconfig.json': null,
        'packages/app/tsconfig.json': null,
        'packages/lib/tsconfig.json': null,
      },
    })

    const result = await project.run()

    expect(result.code).toBe(1)
    expect(result.stdout).toBe(
      [
        `uncheck in ${project.root}`,
        '○ sherif skipped, not installed',
        '○ oxlint skipped, not installed',
        '○ oxfmt skipped, not installed',
        '○ tsc skipped, no tsconfig.json found',
        '',
        '✘ nothing to check: sherif not installed, oxlint not installed, oxfmt not installed, tsc no tsconfig.json found',
        '',
      ].join('\n'),
    )
  })

  it('fails when a tsconfig.json exists but typescript is not installed', async () => {
    const project = createProject(layout, { tools: ['oxlint'] })

    const result = await project.run()

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('✔ oxlint passed')
    expect(result.stdout).toContain(
      `✘ tsc found ${count - 2} tsconfig.json but typescript is not installed\n`,
    )
    expect(result.stdout).toContain('✘ 1 of 2 checks failed: tsc\n')
    expect(result.stdout).not.toContain('rerun with')
  })

  it.skipIf(process.platform === 'win32')(
    'fails a check whose tool is killed and still runs the others, and times slow ones in seconds',
    async () => {
      const project = createProject(layout, {
        tools: ['oxfmt', 'typescript'],
        files: fakeTool(
          'oxlint',
          "if (process.env.FAKE === 'kill') process.kill(process.pid, 'SIGKILL')\nsetTimeout(() => {}, 1100)\n",
        ),
      })

      const killed = await project.run([], { env: { FAKE: 'kill' } })

      expect(killed.code).toBe(1)
      expect(killed.stdout).toContain(
        "▶ oxlint\nProcess interrupted due to receipt of signal: 'SIGKILL'\n✘ oxlint failed",
      )
      expect(killed.stdout).toContain('✔ tsc passed')
      expect(killed.stdout).toContain('✘ 1 of 3 checks failed: oxlint\n')
      expect(killed.stdout).not.toContain('PlatformError')

      const slow = await project.run(['--only=oxlint'])

      expect(slow.code).toBe(0)
      expect(slow.stdout).toMatch(/✔ oxlint passed \d+\.\ds\n/)
    },
  )
})
