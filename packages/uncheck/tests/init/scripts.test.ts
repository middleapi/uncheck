import { singleRepo } from '../utils/project'
import { SCRIPTS, manifest, manifestOf } from './utils'

describe('init adds its scripts next to the ones a project has', () => {
  it('keeps the existing scripts and their order, adding the missing ones after them', async () => {
    const project = singleRepo(manifest({ scripts: { test: 'vitest', fix: 'eslint --fix' } }))

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'])

    expect(exitCode).toBe(0)
    expect(stdout).toContain('✔ package.json scripts check and prepare written\n')
    expect(stdout).toContain(
      '\nRun pnpm run check to check the project, and pnpm exec uncheck --fix to fix what can be fixed.\n',
    )
    expect(Object.entries(manifestOf(project).scripts as object)).toEqual([
      ['test', 'vitest'],
      ['fix', 'eslint --fix'],
      ['check', 'uncheck'],
      ['prepare', 'uncheck prepare --pre-commit'],
    ])
  })

  it.each([
    ['husky', 'husky && uncheck prepare --pre-commit'],
    ['', 'uncheck prepare --pre-commit'],
  ])('turns the prepare script %j into %j', async (prepare, written) => {
    const project = singleRepo(
      manifest({ scripts: { check: 'uncheck', fix: 'uncheck --fix', prepare } }),
    )

    const { exitCode } = await project.uncheck(['init', '--yes'])

    expect(exitCode).toBe(0)
    expect(manifestOf(project).scripts).toEqual({
      check: 'uncheck',
      fix: 'uncheck --fix',
      prepare: written,
    })
  })

  it('leaves the hook to a prepare script that already runs uncheck prepare', async () => {
    const scripts = {
      check: 'uncheck',
      fix: 'uncheck --fix',
      prepare: 'husky && uncheck prepare --pre-commit --only=oxlint',
    }
    const project = singleRepo(manifest({ scripts }))

    const { exitCode, stdout } = await project.uncheck(['init', '--yes'])

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      '✔ package.json unchanged\n○ pre-commit left to the prepare script, which writes it on every install\n',
    )
    expect(manifestOf(project).scripts).toEqual(scripts)
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })
})

describe('init keeps the indentation of package.json', () => {
  it.each([
    ['tabs', '{\n\t"name": "app",\n\t"private": true\n}\n', '\t'],
    ['four spaces', '{\n    "name": "app",\n    "private": true\n}\n', '    '],
    ['nothing, on one line', '{"name":"app","private":true}\n', '  '],
  ])('indented with %s', async (_, text, indent) => {
    const project = singleRepo({ 'package.json': text })

    const { exitCode } = await project.uncheck(['init', '--yes'])

    expect(exitCode).toBe(0)
    expect(project.read('package.json')).toBe(
      `${JSON.stringify(
        {
          name: 'app',
          private: true,
          scripts: SCRIPTS,
        },
        null,
        indent,
      )}\n`,
    )
  })
})
