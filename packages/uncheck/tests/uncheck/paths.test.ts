import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  cliError,
  LAYOUTS,
  monorepo,
  PERMISSIONS_ENFORCED,
  report,
  temporaryDirectory,
} from '../utils/project'
import { CLEAN_CODE, CODE_WITH_VAR, selectedReport } from './utils'

describe.each(LAYOUTS)('uncheck selecting files by path in a $name', ({ create, app }) => {
  it('checks every file below a directory it is given', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/routes/nested/legacy.ts`]: CODE_WITH_VAR,
      [`${app}scripts/legacy.ts`]: CODE_WITH_VAR,
    })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', `${app}src/routes/`])

    expect(exitCode).toBe(1)
    expect(stdout).toContain(`${app}src/routes/nested/legacy.ts:1:1`)
    expect(stdout).toContain('eslint(no-var)')
    expect(stdout).not.toContain('scripts/legacy.ts')
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/routes/home.ts ${app}src/routes/nested/legacy.ts`,
      '✘ oxlint failed',
      '✘ 1 of 1 checks failed: oxlint',
      '  rerun with `--fix` to apply oxlint fixes',
    ])
  })

  it('checks a file named by several paths once', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/routes/nested/about.ts`]: CLEAN_CODE,
    })

    const { exitCode, stdout } = await project.uncheck([
      '--only=oxlint',
      `${app}src/routes/nested`,
      `${app}src/routes/*.ts`,
      `${app}src/routes/home.ts`,
      `./${app}src/routes/nested/../home.ts`,
    ])

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${app}src/routes/home.ts ${app}src/routes/nested/about.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('resolves paths against --cwd rather than the directory it starts in', async () => {
    const project = create({ 'index.ts': CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck([
      '--only=oxlint',
      `--cwd=${app}src`,
      'index.ts',
    ])

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      '▶ oxlint --no-error-on-unmatched-pattern index.ts',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('resolves paths against the subdirectory it starts in', async () => {
    const project = create({ 'index.ts': CODE_WITH_VAR })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', 'index.ts'], {
      cwd: `${app}src`,
    })

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      '▶ oxlint --no-error-on-unmatched-pattern index.ts',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('follows "../" back into the directory it runs in', async () => {
    const project = create({ [`${app}src/routes/home.ts`]: CLEAN_CODE })

    const { exitCode, stdout } = await project.uncheck(
      ['--only=oxlint', '../routes/home.ts', '../routes'],
      { cwd: `${app}src/routes` },
    )

    expect(exitCode).toBe(0)
    expect(selectedReport(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src/routes')}`,
      '▶ oxlint --no-error-on-unmatched-pattern home.ts',
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
  })

  it('takes an absolute path through a linked folder to the directory it runs in', async () => {
    const routes = `${app}src/routes`
    const project = create({
      [`${routes}/home.ts`]: CLEAN_CODE,
      [`${routes}/legacy.ts`]: CODE_WITH_VAR,
    })
    const links = temporaryDirectory()
    const linked = join(links, 'linked')
    const elsewhere = temporaryDirectory()
    writeFileSync(join(elsewhere, 'shared.ts'), CLEAN_CODE)
    symlinkSync(project.dir, linked)
    symlinkSync(elsewhere, join(links, 'elsewhere'))

    const through = await project.uncheck([
      '--only=oxlint',
      join(linked, routes, 'home.ts'),
      join(linked, routes, '*.ts'),
      `!${join(linked, routes, 'legacy.ts')}`,
    ])
    const fromLink = await project.uncheck([
      '--only=oxlint',
      `--cwd=${linked}`,
      project.path(routes, 'home.ts'),
    ])
    const outside = join(links, 'elsewhere/shared.ts')
    const rejected = await project.uncheck(['--only=oxlint', outside])

    expect(through.stderr).toBe('')
    expect(through.exitCode).toBe(0)
    expect(selectedReport(through.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
    expect(fromLink.stderr).toBe('')
    expect(fromLink.exitCode).toBe(0)
    expect(selectedReport(fromLink.stdout)).toEqual([
      `uncheck in ${project.dir}`,
      `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
      '✔ oxlint passed',
      '✔ all checks passed (oxlint)',
    ])
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr).toBe(
      cliError(
        `${outside} is outside ${project.dir}, run from a folder that contains it or pass one with --cwd`,
      ),
    )
  })

  it('fails naming a file, directory or glob above the directory it runs in', async () => {
    const project = create({
      [`${app}src/routes/home.ts`]: CLEAN_CODE,
      [`${app}src/legacy.ts`]: CODE_WITH_VAR,
    })
    const elsewhere = temporaryDirectory()
    const outside = join(elsewhere, 'shared.ts')
    const looping = join(elsewhere, 'loop')
    writeFileSync(outside, CLEAN_CODE)
    symlinkSync(looping, looping)
    const routes = `${app}src/routes`

    for (const pattern of ['../legacy.ts', '..', '../*.ts', outside, join(looping, 'shared.ts')]) {
      const fromInside = await project.uncheck(['--only=oxlint', 'home.ts', pattern], {
        cwd: routes,
      })
      const withCwd = await project.uncheck([
        '--only=oxlint',
        '--no-error-on-unmatched-pattern',
        `--cwd=${routes}`,
        pattern,
      ])

      for (const { exitCode, stdout, stderr } of [fromInside, withCwd]) {
        expect(exitCode).toBe(1)
        expect(report(stdout)).toEqual([`uncheck in ${project.path(routes)}`])
        expect(stderr).toBe(
          cliError(
            `${pattern} is outside ${project.path(routes)}, run from a folder that contains it or pass one with --cwd`,
          ),
        )
      }
    }
  })

  it.runIf(PERMISSIONS_ENFORCED)(
    'fails naming, and ignores leaving out, a file in a folder outside it cannot look into',
    async () => {
      const routes = `${app}src/routes`
      const project = create({ [`${routes}/home.ts`]: CLEAN_CODE })
      const locked = temporaryDirectory()
      const hidden = join(locked, 'inner/shared.ts')
      mkdirSync(dirname(hidden))
      writeFileSync(hidden, CLEAN_CODE)
      chmodSync(locked, 0)

      const named = await project.uncheck(['--only=oxlint', hidden])
      const excluded = await project.uncheck(['--only=oxlint', routes, `!${hidden}`])

      expect(named.exitCode).toBe(1)
      expect(named.stderr).toBe(
        cliError(
          `${hidden} is outside ${project.dir}, run from a folder that contains it or pass one with --cwd`,
        ),
      )
      expect(excluded.stderr).toBe('')
      expect(excluded.exitCode).toBe(0)
      expect(selectedReport(excluded.stdout)).toEqual([
        `uncheck in ${project.dir}`,
        `▶ oxlint --no-error-on-unmatched-pattern ${routes}/home.ts`,
        '✔ oxlint passed',
        '✔ all checks passed (oxlint)',
      ])
    },
  )
})

describe('uncheck selecting files by path in a monorepo package', () => {
  it('resolves paths from the package directory and checks that package alone', async () => {
    const project = monorepo({
      'packages/core/src/legacy.ts': CODE_WITH_VAR,
      'packages/app/src/extra.ts': CLEAN_CODE,
    })

    const { exitCode, stdout, stderr } = await project.uncheck(['src', 'package.json'], {
      cwd: 'packages/app',
    })

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout)).toEqual([
      `uncheck in ${project.path('packages/app')}`,
      '○ sherif skipped, not a workspace root',
      '▶ oxlint --no-error-on-unmatched-pattern package.json src/extra.ts src/index.ts',
      '✔ oxlint passed',
      '▶ oxfmt --check --no-error-on-unmatched-pattern package.json src/extra.ts src/index.ts',
      '✔ oxfmt passed',
      '▶ tsc -b tsconfig.json',
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
  })
})
