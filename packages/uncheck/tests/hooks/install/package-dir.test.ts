import { createProject } from '../../_shared/project'

const HOOK = 'npx --no uncheck hooks run --fix'

describe('monorepo', () => {
  it('names the package below the top of the repository in the hook command', async () => {
    const project = createProject('monorepo', { tools: [] })

    const top = await project.run(['hooks', 'install', 'claude', 'copilot'])

    expect(top.code).toBe(0)

    const { code, stdout } = await project.run(['hooks', 'install', 'claude', 'cursor'], {
      cwd: 'packages/app',
    })

    expect(code).toBe(0)
    expect(stdout).toContain('✔ Claude Code .claude/settings.json created\n')
    expect(stdout).toContain(`The hook runs ${HOOK} --dir=packages/app whenever`)
    expect(JSON.parse(project.read('packages/app/.claude/settings.json'))).toEqual({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: `${HOOK} --dir=packages/app`, timeout: 600 }] },
        ],
      },
    })
    expect(JSON.parse(project.read('packages/app/.cursor/hooks.json'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: `${HOOK} --dir=packages/app`, timeout: 600 }] },
    })
    // The hook at the top stays as it is.
    expect(JSON.parse(project.read('.claude/settings.json')).hooks.Stop[0].hooks[0].command).toBe(
      HOOK,
    )

    const again = await project.run(['hooks', 'install', 'claude'], { cwd: 'packages/app' })

    expect(again.stdout).toContain('✔ Claude Code .claude/settings.json unchanged\n')

    // --cwd names the package from anywhere.
    const fromTop = await project.run(['hooks', 'install', 'codebuddy', '--cwd', 'packages/lib'])

    expect(fromTop.code).toBe(0)
    expect(
      JSON.parse(project.read('packages/lib/.codebuddy/settings.json')).hooks.Stop[0].hooks[0]
        .command,
    ).toBe(`${HOOK} --dir=packages/lib`)
  })

  it('refuses Copilot below the top, where it never reads .github/hooks', async () => {
    const project = createProject('monorepo', { tools: [] })

    const { code, stderr } = await project.run(['hooks', 'install', 'claude', 'copilot'], {
      cwd: 'packages/app',
    })

    expect(code).toBe(1)
    expect(stderr).toContain(
      'Copilot reads .github/hooks only at the top of the repository, not in packages/app: install copilot from there',
    )
    expect(project.exists('packages/app/.claude')).toBe(false)
    expect(project.exists('packages/app/.github')).toBe(false)
  })

  it('refuses a directory the hook command could not name', async () => {
    const project = createProject('monorepo', {
      tools: [],
      files: { 'packages/my app/package.json': JSON.stringify({ name: 'my-app' }) },
    })

    const { code, stderr } = await project.run(['hooks', 'install', 'claude'], {
      cwd: 'packages/my app',
    })

    expect(code).toBe(1)
    expect(stderr).toContain(
      'The hook command cannot name packages/my app: install from the top of the repository or from a directory whose path has only letters, digits and _=./@+-',
    )
    expect(project.exists('packages/my app/.claude')).toBe(false)
  })
})
