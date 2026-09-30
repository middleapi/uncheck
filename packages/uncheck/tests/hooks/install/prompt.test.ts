import process from 'node:process'

import { createProject, eachLayout } from '../../_shared/project'
import { inTerminal } from '../shell'

const PROMPT = 'Which agents should run uncheck when they finish a turn?'
// The list opens on "Select All" and "Inverse Selection", then the agents in order.
const DOWN = 'j'
const TOGGLE = ' '
const ENTER = '\r'

eachLayout('$layout', ({ layout }) => {
  it.runIf(process.platform === 'linux')(
    'asks which agents to configure in a terminal, and wants at least one',
    async () => {
      const project = createProject(layout, { tools: [] })

      const { code, stdout } = await inTerminal(project, ['hooks', 'install', '--skip=tsc'], {
        prompt: PROMPT,
        keys: [ENTER, DOWN, DOWN, TOGGLE, DOWN, DOWN, TOGGLE, ENTER],
      })

      expect(code).toBe(0)
      expect(stdout).toContain('At least 1 are required')
      expect(stdout).toContain('✔ Claude Code .claude/settings.json created')
      expect(stdout).toContain('✔ Cursor .cursor/hooks.json created')
      expect(JSON.parse(project.read('.cursor/hooks.json'))).toEqual({
        version: 1,
        hooks: { stop: [{ command: 'npx --no uncheck hooks run --fix --skip=tsc', timeout: 600 }] },
      })
      expect(project.exists('.claude/settings.json')).toBe(true)
      expect(project.exists('.codebuddy')).toBe(false)
      expect(project.exists('.github')).toBe(false)
    },
  )
})

it.runIf(process.platform === 'linux')(
  'refuses Copilot picked in the prompt below the top of a monorepo',
  async () => {
    const project = createProject('monorepo', { tools: [] })

    const { code, stdout } = await inTerminal(project, ['hooks', 'install'], {
      cwd: 'packages/app',
      prompt: PROMPT,
      keys: [DOWN, DOWN, TOGGLE, DOWN, DOWN, DOWN, TOGGLE, ENTER],
    })

    expect(code).toBe(1)
    expect(stdout).toContain('Claude Code, GitHub Copilot')
    expect(stdout).toContain('Copilot reads .github/hooks only at the top of the repository')
    expect(project.exists('packages/app/.claude')).toBe(false)
  },
)
