import { claudeSettings, cursorHooks, hookCommand } from '../hooks/install/utils'
import type { Files, Project } from '../utils/project'
import { DOWN, ENTER, SPACE, fromAnswer, monorepo } from '../utils/project'
import {
  SCRIPTS,
  bareProject,
  fakePackageManagers,
  initOutput,
  manifest,
  manifestOf,
} from './utils'

const TOOLS = 'Which tools should uncheck install?'
const PRESETS = 'Which tools should get a config from the middleapi preset?'
const COMMIT = 'Check the staged files before every commit?'
const AGENTS = 'Which agents should run uncheck when they finish a turn?'

describe('init in a terminal', () => {
  it('installs the chosen tools and writes the chosen preset, hook and agent configs', async () => {
    const project = bareProject()
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheckInTerminal(['init'], {
      env,
      answers: [
        { waitFor: TOOLS, keys: [DOWN, DOWN, DOWN, SPACE, ENTER] },
        { waitFor: PRESETS, keys: [DOWN, DOWN, SPACE, ENTER] },
        { waitFor: COMMIT, keys: [ENTER] },
        { waitFor: AGENTS, keys: [DOWN, DOWN, SPACE, ENTER] },
      ],
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      `? ${TOOLS} › \n  Select None\n  Inverse Selection\n  ☒ oxlint \n  ☒ oxfmt `,
    )
    expect(stdout).toContain(`✔ ${TOOLS} …  oxlint\n`)
    expect(stdout).toContain(`✔ ${PRESETS} …  oxlint\n`)
    expect(stdout).toContain(`✔ ${COMMIT} … yes\n`)
    expect(fromAnswer(stdout, AGENTS)).toBe(
      `✔ ${AGENTS} …  Claude Code\n${initOutput([
        '▶ pnpm add --save-dev uncheck oxlint',
        'pnpm added uncheck oxlint',
        '✔ oxlint oxlint.config.ts created',
        '✔ package.json scripts check, fix and prepare written',
        '✔ pre-commit .git/hooks/pre-commit created',
        '✔ Claude Code .claude/settings.json created',
      ])}`,
    )
    expect(calls()).toEqual(['pnpm add --save-dev uncheck oxlint'])
    expect(project.read('oxlint.config.ts')).toBe(
      "import { defineConfig } from 'oxlint'\nimport { middleapi } from 'uncheck/oxlint'\n\nexport default defineConfig({ extends: [middleapi] })\n",
    )
    expect(project.exists('.git/hooks/pre-commit')).toBe(true)
    expect(JSON.parse(project.read('.claude/settings.json'))).toEqual(
      claudeSettings(hookCommand('')),
    )
  })

  it('writes a preset config CommonJS can load, and no hooks when declined', async () => {
    const project = bareProject(manifest({ type: 'commonjs' }))
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheckInTerminal(['init'], {
      env,
      answers: [
        { waitFor: TOOLS, keys: [ENTER] },
        { waitFor: PRESETS, keys: [DOWN, DOWN, DOWN, SPACE, ENTER] },
        { waitFor: COMMIT, keys: ['n'] },
        { waitFor: AGENTS, keys: [ENTER] },
      ],
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(`✔ ${COMMIT} … no\n`)
    expect(fromAnswer(stdout, AGENTS)).toBe(
      `✔ ${AGENTS} …  \n${initOutput([
        '▶ pnpm add --save-dev uncheck oxlint oxfmt',
        'pnpm added uncheck oxlint oxfmt',
        '✔ oxfmt oxfmt.config.mts created',
        '✔ package.json scripts check and fix written',
      ])}`,
    )
    expect(calls()).toEqual(['pnpm add --save-dev uncheck oxlint oxfmt'])
    expect(project.read('oxfmt.config.mts')).toBe(
      "import { defineConfig } from 'oxfmt'\nimport { middleapi } from 'uncheck/oxfmt'\n\nexport default defineConfig({ ...middleapi })\n",
    )
    expect(project.exists('oxlint.config.mts')).toBe(false)
    expect(manifestOf(project).scripts).toEqual({ check: 'uncheck', fix: 'uncheck --fix' })
    expect(project.exists('.git/hooks/pre-commit')).toBe(false)
  })

  it('asks only what is not set up yet, offering neither Copilot below the top nor hooked agents', async () => {
    const command = hookCommand('packages/app/')
    const project = setUpPackage({
      'packages/app/.claude/agents/review.md': '# Review\n',
      'packages/app/.codebuddy/settings.json': claudeSettings(`${command} --only=oxlint`),
    })
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheckInTerminal(['init'], {
      cwd: 'packages/app',
      env,
      answers: [{ waitFor: AGENTS, keys: [ENTER] }],
    })

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain(TOOLS)
    expect(stdout).not.toContain(PRESETS)
    expect(stdout).not.toContain(COMMIT)
    expect(stdout).toContain(
      `? ${AGENTS} › \n  Select All\n  Inverse Selection\n  ☒ Claude Code \n  ☐ Cursor `,
    )
    expect(stdout).not.toContain('GitHub Copilot')
    expect(fromAnswer(stdout, AGENTS)).toBe(
      `✔ ${AGENTS} …  Claude Code\n${initOutput([
        '✔ package.json unchanged',
        '○ pre-commit left to the prepare script, which writes it on every install',
        '○ CodeBuddy .codebuddy/settings.json already runs uncheck',
        '✔ Claude Code .claude/settings.json created',
      ])}`,
    )
    expect(calls()).toEqual([])
    expect(JSON.parse(project.read('packages/app/.claude/settings.json'))).toEqual(
      claudeSettings(command),
    )
    expect(JSON.parse(project.read('packages/app/.codebuddy/settings.json'))).toEqual(
      claudeSettings(`${command} --only=oxlint`),
    )
  })

  it('asks nothing once everything is set up', async () => {
    const command = hookCommand('packages/app/')
    const project = setUpPackage({
      'packages/app/.claude/settings.json': claudeSettings(command),
      'packages/app/.codebuddy/settings.json': claudeSettings(command),
      'packages/app/.cursor/hooks.json': cursorHooks(command),
    })
    const { env, calls } = fakePackageManagers()

    const { exitCode, stdout } = await project.uncheckInTerminal(['init'], {
      cwd: 'packages/app',
      env,
    })

    expect(project.normalize(stdout)).toBe(
      `uncheck init in <project>/packages/app\n○ inside the workspace at ../.., run uncheck init there to set up every package\n${initOutput(
        [
          '✔ package.json unchanged',
          '○ pre-commit left to the prepare script, which writes it on every install',
          '○ Claude Code .claude/settings.json already runs uncheck',
          '○ CodeBuddy .codebuddy/settings.json already runs uncheck',
          '○ Cursor .cursor/hooks.json already runs uncheck',
        ],
      )}`,
    )
    expect(exitCode).toBe(0)
    expect(calls()).toEqual([])
  })
})

function setUpPackage(files: Files): Project {
  return monorepo({ '.oxfmtrc.json': {}, ...files }).update(
    'packages/app/package.json',
    (manifest) => ({ ...manifest, scripts: SCRIPTS }),
  )
}
