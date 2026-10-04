import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import {
  FULL_OXFMT,
  FULL_OXLINT,
  LAYOUTS,
  monorepo,
  report,
  singleRepo,
  SKIPPED_FOR_DELETIONS,
  temporaryDirectory,
  UTILS_NOT_FOUND,
} from '../../utils/project'
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
        '○ fallow skipped, not installed',
        '✔ all checks passed (oxlint, oxfmt, tsc)',
      ])
      expect(project.read(`${app}src/index.ts`)).toBe(`${index}export const later = 2;\n`)
      expect(project.read(`${app}src/extra.ts`)).toBe('export const extra = 1;\n')
      expect(project.read(`${app}src/legacy.ts`)).toBe(UNFORMATTED)
      expect(project.read(`${app}dist/bundle.js`)).toBe('export var   bundle = 1\n')
    })

    it('leaves alone installed packages that no ignore rule covers, links into them and links leaving the project', async () => {
      const store = temporaryDirectory()
      writeFileSync(join(store, 'shared.ts'), UNFORMATTED)
      const dependency = `${app}lib/node_modules/dep/index.js`
      const project = create({ '.gitignore': '/node_modules\ndist\n*.tsbuildinfo\n' })
        .write({
          [dependency]: 'export var   dep = 1\n',
          [`${app}src/extra.ts`]: 'export const   extra = 1\n',
        })
        .link(`${app}src/shared.ts`, join(store, 'shared.ts'))
        .link(`${app}src/vendor.js`, '../lib/node_modules/dep/index.js')

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
        '○ fallow skipped, not selected by --only',
        '✔ all checks passed (oxlint, oxfmt)',
      ])
      expect(project.read(`${app}src/extra.ts`)).toBe('export const extra = 1;\n')
      expect(project.read(dependency)).toBe('export var   dep = 1\n')
      expect(readFileSync(join(store, 'shared.ts'), 'utf8')).toBe(UNFORMATTED)
    })

    it('never hands oxlint or oxfmt a deleted file, even one whose name reads as a pattern', async () => {
      const project = create({
        [`${app}src/[id].ts`]: 'export const id = 1;\n',
        [`${app}src/i.ts`]: UNFORMATTED,
      }).write({ [`${app}src/[id].ts`]: null })

      const deleted = await stopHook(project, app, CLAUDE_CODE_STOP)

      expect(deleted.exitCode).toBe(0)
      expect(deleted.stdout).toBe('')
      expect(report(deleted.stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        ...SKIPPED_FOR_DELETIONS,
        tsc,
        '✔ tsc passed',
        '○ fallow skipped, not installed',
        '✔ all checks passed (tsc)',
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
        '○ fallow skipped, not selected by --only',
        '✔ all checks passed (oxfmt)',
      ])
      expect(project.read(`${app}src/new.ts`)).toBe('export const fresh = 1;\n')
      expect(project.read(`${app}src/i.ts`)).toBe(UNFORMATTED)
    })

    it('checks only the changed files beside a file named HEAD', async () => {
      const project = create({
        [`${app}HEAD`]: 'not a revision\n',
        [`${app}src/legacy.ts`]: UNFORMATTED,
      }).write({ [`${app}src/extra.ts`]: 'export const extra = 1;\n' })

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
        args: ['--only=oxfmt'],
      })

      expect(exitCode).toBe(0)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '▶ oxfmt --check --no-error-on-unmatched-pattern src/extra.ts',
        '✔ oxfmt passed',
        '○ tsc skipped, not selected by --only',
        '○ fallow skipped, not selected by --only',
        '✔ all checks passed (oxfmt)',
      ])
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
        FULL_OXLINT,
        '✔ oxlint passed',
        FULL_OXFMT,
        '✘ oxfmt failed',
        tsc,
        '✔ tsc passed',
        '○ fallow skipped, not installed',
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
        FULL_OXFMT,
        '✘ oxfmt failed',
        '○ tsc skipped, not selected by --only',
        '○ fallow skipped, not selected by --only',
        '✘ 1 of 1 checks failed: oxfmt',
        '  rerun with `--fix` to apply oxfmt fixes',
      ])
      expect(stderr).toContain('src/legacy.ts')
    })

    it('hands fallow the changed files from the root of the project', async () => {
      const orphan = 'export const orphan = 1;\n'
      const project = create({ [`${app}lib/old.ts`]: orphan }, { tools: ['fallow'] }).write({
        [`${app}src/orphan.ts`]: orphan,
      })

      const { exitCode, stdout, stderr } = await stopHook(project, app, CLAUDE_CODE_STOP, {
        args: ['--fix', '--only=fallow'],
      })

      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(stderr).toContain(`Unused files (1)\n  ${app}src/orphan.ts\n`)
      expect(report(stderr)).toEqual([
        `uncheck in ${project.path(app, '.')}`,
        '○ sherif skipped, not selected by --only',
        '○ oxlint skipped, not selected by --only',
        '○ oxfmt skipped, not selected by --only',
        '○ tsc skipped, not selected by --only',
        app === ''
          ? '▶ fallow dead-code --quiet --file=src/orphan.ts'
          : `▶ fallow dead-code --quiet --root=../.. --file=${app}src/orphan.ts`,
        '✘ fallow failed',
        '✘ 1 of 1 checks failed: fallow',
      ])
      expect(project.read(`${app}src/orphan.ts`)).toBe(orphan)
    })
  },
)

describe('hooks run with deleted files in a single repo', () => {
  it.each([[[]], [['--require=tsc']]])(
    'sends the agent back when a deleted file is still imported, with %j',
    async (flags) => {
      const project = singleRepo().write({ 'src/utils.ts': null })

      const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP, {
        args: ['--fix', ...flags],
      })

      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(report(stderr)).toEqual([
        `uncheck in ${project.dir}`,
        ...SKIPPED_FOR_DELETIONS,
        '▶ tsc -p tsconfig.json --noEmit',
        '✘ tsc failed',
        '○ fallow skipped, not installed',
        '✘ 1 of 1 checks failed: tsc',
      ])
      expect(stderr).toContain(UTILS_NOT_FOUND)
    },
  )

  it('sends the agent back when a moved file is still imported from where it was', async () => {
    const project = singleRepo()

    mkdirSync(project.path('scripts'))
    project.git('mv', 'src/utils.ts', 'scripts/utils.ts')

    const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP)

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, no package.json among the given files',
      '▶ oxlint --fix --no-error-on-unmatched-pattern scripts/utils.ts',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern scripts/utils.ts',
      '✔ oxfmt passed',
      '▶ tsc -p tsconfig.json --noEmit',
      '✘ tsc failed',
      '○ fallow skipped, not installed',
      '✘ 1 of 3 checks failed: tsc',
    ])
    expect(stderr).toContain(UTILS_NOT_FOUND)
  })
})

describe('hooks run with a changed package.json in a monorepo', () => {
  it('only reports what sherif finds, since its fixes reach beyond the change', async () => {
    const project = monorepo()
      .update('packages/core/package.json', (manifest) => ({
        ...manifest,
        dependencies: { zod: '^3.0.0' },
      }))
      .commit('zod')
      .update('packages/app/package.json', (manifest) => ({
        ...manifest,
        dependencies: { '@repo/core': 'workspace:*', 'zod': '^3.1.0' },
      }))
    const manifests = ['package.json', 'packages/core/package.json', 'packages/app/package.json']
    const before = manifests.map((file) => project.read(file))

    const { exitCode, stdout, stderr } = await stopHook(project, '', CLAUDE_CODE_STOP)

    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(report(stderr)).toEqual([
      `uncheck in ${project.dir}`,
      '▶ sherif',
      '✘ sherif failed',
      '▶ oxlint --fix --no-error-on-unmatched-pattern packages/app/package.json',
      '✔ oxlint passed',
      '▶ oxfmt --no-error-on-unmatched-pattern packages/app/package.json',
      '✔ oxfmt passed',
      '○ tsc skipped, no tsconfig.json covers the given files',
      '○ fallow skipped, not installed',
      '✘ 1 of 3 checks failed: sherif',
    ])
    expect(stderr).toContain('multiple-dependency-versions')
    expect(manifests.map((file) => project.read(file))).toEqual(before)
  })
})
