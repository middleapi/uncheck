import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { LAYOUTS, report, temporaryDirectory } from '../../utils/project'
import { CLAUDE_CODE_STOP, stopHook } from './utils'

const UNFORMATTED = 'export const   legacy = 1\n'

describe.each(LAYOUTS)(
  'hooks run checks what changed since the last commit in a $name',
  ({ create, app, tsc }) => {
    it('stays silent when nothing changed', async () => {
      const project = create({ [`${app}src/legacy.ts`]: UNFORMATTED })

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP)

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe('')
      expect(project.read(`${app}src/legacy.ts`)).toBe(UNFORMATTED)
    })

    it('fixes the changed and untracked files, leaving ignored and unchanged ones alone', async () => {
      const project = create({ [`${app}src/legacy.ts`]: UNFORMATTED })
      const index = project.read(`${app}src/index.ts`)

      project.write({
        [`${app}src/index.ts`]: `${index}export var   later = 2\n`,
        [`${app}src/extra.ts`]: 'export const   extra = 1\n',
        [`${app}dist/bundle.js`]: 'export var   bundle = 1\n',
      })

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
        env: { FORCE_COLOR: '1' },
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(stripVTControlCharacters(stderr)).toBe(stderr)
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, no package.json among the given files',
        '▶ oxlint --fix --no-error-on-unmatched-pattern src/extra.ts src/index.ts',
        '✔ oxlint passed',
        '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts src/index.ts',
        '✔ oxfmt passed',
        tsc,
        '✔ tsc passed',
        '✔ all checks passed (oxlint, oxfmt, tsc)',
      ])
      expect(project.read(`${app}src/index.ts`)).toBe(`${index}export const later = 2;\n`)
      expect(project.read(`${app}src/extra.ts`)).toBe('export const extra = 1;\n')
      expect(project.read(`${app}src/legacy.ts`)).toBe(UNFORMATTED)
      expect(project.read(`${app}dist/bundle.js`)).toBe('export var   bundle = 1\n')
    })

    it('leaves installed packages that no ignore rule covers and links leaving the project alone', async () => {
      const store = temporaryDirectory()
      writeFileSync(join(store, 'shared.ts'), UNFORMATTED)
      const dependency = `${app}lib/node_modules/dep/index.js`
      const project = create({ '.gitignore': '/node_modules\ndist\n*.tsbuildinfo\n' })
        .write({
          [dependency]: 'export var   dep = 1\n',
          [`${app}src/extra.ts`]: 'export const   extra = 1\n',
        })
        .link(`${app}src/shared.ts`, join(store, 'shared.ts'))

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
        args: ['--fix', '--only=oxlint', '--only=oxfmt'],
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '▶ oxlint --fix --no-error-on-unmatched-pattern src/extra.ts',
        '✔ oxlint passed',
        '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts',
        '✔ oxfmt passed',
        '○ tsc skipped, not selected by --only',
        '✔ all checks passed (oxlint, oxfmt)',
      ])
      expect(project.read(`${app}src/extra.ts`)).toBe('export const extra = 1;\n')
      expect(project.read(dependency)).toBe('export var   dep = 1\n')
      expect(readFileSync(join(store, 'shared.ts'), 'utf8')).toBe(UNFORMATTED)
    })

    it('leaves a file deleted since the last commit out, even one whose name reads as a pattern', async () => {
      const project = create({
        [`${app}src/[id].ts`]: 'export const id = 1;\n',
        [`${app}src/i.ts`]: UNFORMATTED,
      }).write({ [`${app}src/[id].ts`]: null })

      const deleted = await stopHook(project, app, CLAUDE_CODE_STOP)

      expect(deleted.exitCode).toBe(0)
      expect(deleted.stdout).toBe('')
      expect(report(deleted.stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ nothing to check, no files match src/[id].ts',
      ])
      expect(project.read(`${app}src/i.ts`)).toBe(UNFORMATTED)

      project.write({ [`${app}src/new.ts`]: 'export const   fresh = 1\n' })

      const alongside = await stopHook(project, app, CLAUDE_CODE_STOP, {
        args: ['--fix', '--only=oxfmt'],
      })

      expect(alongside.exitCode).toBe(0)
      expect(alongside.stdout).toBe('')
      expect(report(alongside.stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '▶ oxfmt --no-error-on-unmatched-pattern src/new.ts',
        '✔ oxfmt passed',
        '○ tsc skipped, not selected by --only',
        '✔ all checks passed (oxfmt)',
      ])
      expect(project.read(`${app}src/new.ts`)).toBe('export const fresh = 1;\n')
      expect(project.read(`${app}src/i.ts`)).toBe(UNFORMATTED)
    })

    it('checks everything under the directory outside git', async () => {
      const project = create({ [`${app}src/legacy.ts`]: UNFORMATTED }, { git: 'none' })

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
        args: [],
      })

      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not a workspace root',
        '▶ oxlint --ignore-pattern=node_modules --no-error-on-unmatched-pattern',
        '✔ oxlint passed',
        '▶ oxfmt --check --no-error-on-unmatched-pattern',
        '✘ oxfmt failed',
        tsc,
        '✔ tsc passed',
        '✘ 1 of 3 checks failed: oxfmt',
        '  rerun with `--fix` to apply oxfmt fixes',
      ])
      expect(stderr).toContain('src/legacy.ts')
    })

    it('checks everything before the first commit', async () => {
      const project = create({ [`${app}src/legacy.ts`]: UNFORMATTED }, { git: 'init' })

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
        args: ['--only=oxfmt'],
      })

      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '▶ oxfmt --check --no-error-on-unmatched-pattern',
        '✘ oxfmt failed',
        '○ tsc skipped, not selected by --only',
        '✘ 1 of 1 checks failed: oxfmt',
        '  rerun with `--fix` to apply oxfmt fixes',
      ])
      expect(stderr).toContain('src/legacy.ts')
    })
  },
)
