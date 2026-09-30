import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { promisify } from 'node:util'

import { createProject, eachLayout, uncheckBin } from '../_shared/project'
import { fakeTool, spawnCli } from './fake-tools'

const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

/** Prints what it sees of colors, then waits as long as `FAKE_MS` says. */
const COLOR_TOOL = fakeTool(
  'oxlint',
  "console.log('FORCE_COLOR=' + process.env.FORCE_COLOR)\nsetTimeout(() => {}, Number(process.env.FAKE_MS ?? 0))\n",
)

const ANSI = '\u001B['

eachLayout('uncheck cli in a $layout repository', ({ layout }) => {
  it('prints its version and help, and has only its own global flags', async () => {
    const project = createProject(layout, { tools: [] })

    const version = await project.run(['--version'])

    expect(version.code).toBe(0)
    expect(version.stdout).toContain(VERSION)

    const help = await project.run(['--help'], { cwd: project.appDir })

    expect(help.code).toBe(0)

    for (const text of ['staged', 'prepare', 'hooks', '--fix', '--only', '--skip', '--require']) {
      expect(help.stdout).toContain(text)
    }

    for (const flag of ['--log-level', '--wizard']) {
      const refused = await project.run([flag])

      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain(`Unrecognized flag: ${flag}`)
    }
  })

  it.skipIf(process.platform === 'win32')('prints a file system failure as an error', async () => {
    const project = createProject(layout, { tools: [], files: { '.claude': '' } })

    const install = await project.run(['hooks', 'install', 'claude'])

    expect(install.code).toBe(1)
    expect(install.stdout).toBe('')
    expect(install.stderr).toContain(project.path('.claude/settings.json'))
  })

  it('exits 2 when an agent hook sends the agent back', async () => {
    const project = createProject(layout)

    project.write({ [project.inApp('src/legacy.ts')]: 'var count = 1\nexport { count }\n' })

    const result = await project.run(['hooks', 'run'], {
      cwd: project.appDir,
      stdin: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('no-var')
  })

  it.skipIf(process.platform === 'win32')(
    'lets a closed terminal end a run through SIGTERM rather than dying on SIGHUP',
    async () => {
      const project = createProject(layout, { tools: [], files: COLOR_TOOL })
      let hungUp = false

      const result = await spawnCli(project, ['--only=oxlint'], {
        env: { FAKE_MS: '60000' },
        onStdout: (stdout, kill) => {
          if (!hungUp && stdout.includes('FORCE_COLOR=')) {
            hungUp = true
            // Twice, as the shell forwards it and then the kernel sends it.
            kill('SIGHUP')
            kill('SIGHUP')
          }
        },
      })

      expect(hungUp).toBe(true)
      expect(result.signal).toBeNull()
      expect(result.code).toBe(130)
      expect(result.stdout).not.toContain('passed')
    },
  )

  it('keeps going when nobody reads its output any more', async () => {
    const project = createProject(layout)

    // What it prints on stdout and on stderr goes nowhere, which changes neither outcome.
    const passed = await spawnCli(project, ['--only=oxlint'], { closePipes: true })

    expect(passed.code).toBe(0)

    const refused = await spawnCli(project, ['missing.ts'], { closePipes: true })

    expect(refused.code).toBe(1)
  })

  it('colors its output and the tools only when asked or on a terminal', async () => {
    const project = createProject(layout, { tools: [], files: COLOR_TOOL })

    const plain = await spawnCli(project, ['--only=oxlint'])

    expect(plain.code).toBe(0)
    expect(plain.stdout).not.toContain(ANSI)
    expect(plain.stdout).toContain('FORCE_COLOR=undefined\n')

    const forced = await spawnCli(project, ['--only=oxlint'], { env: { FORCE_COLOR: '1' } })

    expect(forced.code).toBe(0)
    expect(forced.stdout).toContain(`${ANSI}1m${'oxlint'}`)
    expect(forced.stdout).toContain('FORCE_COLOR=1\n')
  })

  it.runIf(process.platform === 'linux')(
    'tells a tool it runs for a terminal, which it cannot see through the pipe',
    async () => {
      const project = createProject(layout, { tools: [], files: COLOR_TOOL })

      const { stdout } = await promisify(execFile)(
        'script',
        ['-qec', `'${process.execPath}' '${uncheckBin(project)}' --only=oxlint`, '/dev/null'],
        // Without TERM, as on a CI runner, Node takes the terminal for one without colors.
        { cwd: project.root, env: { ...project.env, TERM: 'xterm-256color' } },
      )

      expect(stdout).toContain(ANSI)
      expect(stdout).toContain('FORCE_COLOR=1\r\n')
      expect(stdout).toContain('all checks passed')
    },
  )
})
