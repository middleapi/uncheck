import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { createProject, eachLayout } from '../_shared/project'
import { fakeRunner, HEADER, HOOK, runHook, shownFrom } from './helpers'

eachLayout('$layout', ({ layout }) => {
  /** A command as a hook line of the package runs it, entering the folder in the monorepo. */
  const within = (command: string) =>
    layout === 'single' ? command : `(cd "packages/app" && ${command})`
  const line = `${within('npx --no uncheck staged --fix')} || exit 1`

  const setUp = () => {
    const project = createProject(layout, { tools: [] })
    const prepare = () => project.run(['prepare', '--pre-commit'], { cwd: project.appDir })

    return { project, prepare, shown: shownFrom(project, project.appDir) }
  }

  it('updates its own line in place, drops copies of it and leaves lines it did not write alone', async () => {
    const { project, prepare, shown } = setUp()
    const mine = 'echo "runs uncheck staged"'

    project.write({
      [HOOK]: `${HEADER}${mine}\n${within('pnpm exec uncheck staged --fix')}\nnpm test\n${within('npx uncheck staged --skip=tsc')}\n`,
    })

    const deduped = await prepare()

    expect(deduped.stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    // The second copy goes, the line that only mentions the command and the unrelated one stay.
    expect(project.read(HOOK)).toBe(`${HEADER}${mine}\n${line}\nnpm test\n`)
    expect((await prepare()).stdout).toContain(`✔ pre-commit ${shown} unchanged\n`)

    // A line that runs more than the command, or does not fail the hook, is the user's own.
    const chained = within('npx uncheck staged --only=oxfmt && npm test')
    const advisory = `${within('npx --no uncheck staged --fix')} || echo "not blocking"`

    project.write({ [HOOK]: `#!/bin/sh\n${chained}\n${advisory}\n` })

    expect((await prepare()).stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    expect(project.read(HOOK)).toBe(`#!/bin/sh\n${line}\n${chained}\n${advisory}\n`)
  })

  it('adds itself before the commands of a hook and makes it executable', async () => {
    const { project, prepare, shown } = setUp()

    writeFileSync(project.path(HOOK), '#!/bin/sh\necho hi', { mode: 0o600 })

    const added = await prepare()

    expect(added).toMatchObject({ code: 0, stderr: '' })
    expect(added.stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    expect(project.read(HOOK)).toBe(`#!/bin/sh\n${line}\necho hi`)
    expect(statSync(project.path(HOOK)).mode & 0o777).toBe(0o755)
  })

  it('adds itself after a hook that only sets up, and fills an empty one', async () => {
    const { project, prepare } = setUp()

    for (const [hook, expected] of [
      ['', `${line}\n`],
      ['#!/bin/sh\n', `#!/bin/sh\n${line}\n`],
      ['#!/bin/sh\n# checks\nset -e', `#!/bin/sh\n# checks\nset -e\n${line}\n`],
    ] as const) {
      project.write({ [HOOK]: hook })

      expect((await prepare()).stdout).toContain(' updated\n')
      expect(project.read(HOOK)).toBe(expected)
    }
  })

  it('runs after the setup of a hook and before its commands, so they still fail it and cannot skip it', async () => {
    const { project, prepare } = setUp()
    const runner = fakeRunner(project, 'npx', '[ "$1" = --no ] || exit 1\n')

    // The PATH comes from the setup, as a GUI client runs hooks without the one of a shell.
    project.write({ '.git/hooks/env': `PATH="${runner.bin}:$PATH"\n` })

    const setup =
      '#!/bin/sh\n# lint\nexport HOOKS="$(dirname "$0")"\n[ -s "$HOOKS/env" ] && \\. "$HOOKS/env"\n'

    project.write({ [HOOK]: `${setup}export CI=1 && exec npx lint-staged\n` })

    await prepare()

    expect(project.read(HOOK)).toBe(`${setup}${line}\nexport CI=1 && exec npx lint-staged\n`)
    expect(runHook(project, {})).toBe(1)
    expect(runner.ran()).toEqual([
      `${project.app} --no uncheck staged --fix`,
      `${project.root} lint-staged`,
    ])
  })

  it('runs before a setup line that continues onto the next, not inside it', async () => {
    const { project, prepare } = setUp()

    for (const setup of [
      'export PATH=/opt/bin:\\\n/usr/bin:$PATH\n',
      'A="\n. b\n"\n',
      "A='\n. b\n'\n",
    ]) {
      project.write({ [HOOK]: `#!/bin/sh\n${setup}npx lint-staged\n` })

      await prepare()

      expect(project.read(HOOK)).toBe(`#!/bin/sh\n${line}\n${setup}npx lint-staged\n`)
    }
  })

  it('leaves a hook in another language alone and says what it should run', async () => {
    const { project, prepare, shown } = setUp()
    const script = '#!/usr/bin/env node\nconsole.log("checked")\n'

    writeFileSync(project.path(HOOK), script, { mode: 0o755 })

    const refused = await prepare()

    expect(refused).toMatchObject({ code: 0, stderr: '' })
    expect(refused.stdout).toBe(
      `✘ pre-commit ${shown} not written, it is not a shell script, have it run \`${line}\` yourself\n`,
    )
    expect(project.read(HOOK)).toBe(script)

    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff])

    writeFileSync(project.path(HOOK), binary)

    expect((await prepare()).stdout).toContain('not written, it is not a shell script')
    expect(readFileSync(project.path(HOOK))).toEqual(binary)

    // Shells by any name are fine.
    for (const shell of ['#!/bin/bash', '#!/usr/bin/env zsh', '#!/bin/dash -e']) {
      project.write({ [HOOK]: `${shell}\n` })

      expect((await prepare()).stdout).toContain(' updated\n')
      expect(project.read(HOOK)).toBe(`${shell}\n${line}\n`)
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'reports a hook it may not read without failing the install',
    async () => {
      const { project, prepare, shown } = setUp()
      const script = '#!/bin/sh\necho hi\n'

      writeFileSync(project.path(HOOK), script, { mode: 0 })

      const refused = await prepare()

      expect(refused.code).toBe(0)
      expect(refused.stdout).toContain(`✘ pre-commit ${shown} not written, EACCES`)
      chmodSync(project.path(HOOK), 0o755)
      expect(project.read(HOOK)).toBe(script)
    },
  )

  it('reports a hook it cannot write without failing the install, and leaves nothing behind', async () => {
    const { project, prepare, shown } = setUp()

    project.write({ [`${HOOK}/keep`]: '' })

    // A `prepare` script that fails would fail the install, so it reports and carries on.
    const refused = await prepare()

    expect(refused.code).toBe(0)
    // Node 26 also names the path in the message.
    expect(refused.stdout).toMatch(
      new RegExp(
        `^✘ pre-commit ${shown.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')} not written, EISDIR: illegal operation on a directory, read(?: '[^']*')?\n$`,
      ),
    )
    expect(
      readdirSync(project.path('.git/hooks')).filter(
        (name) => name.includes('uncheck') || name.endsWith('.lock'),
      ),
    ).toEqual([])

    // Nor where the hooks folder cannot be made.
    project.remove('.git/hooks')
    project.write({ '.git/hooks': '' })

    const blocked = await prepare()

    expect(blocked.code).toBe(0)
    expect(blocked.stdout).toMatch(
      new RegExp(`^✘ pre-commit ${shown.replaceAll('.', '\\.')} not written, E`),
    )
    expect(project.read('.git/hooks')).toBe('')
  })

  it('creates the hooks folder when a clone has none', async () => {
    const { project, prepare, shown } = setUp()

    project.remove('.git/hooks')

    expect((await prepare()).stdout).toContain(`✔ pre-commit ${shown} created\n`)
    expect(project.read(HOOK)).toBe(`${HEADER}${line}\n`)
  })

  it('writes the script a symlinked hook points to, even one not there yet, and keeps the link', async () => {
    const { project, prepare, shown } = setUp()
    const hook = project.path(HOOK)

    project.write({ 'scripts/pre-commit': '#!/bin/sh\nnpm test\n' })
    symlinkSync('../../scripts/pre-commit', hook)

    expect((await prepare()).stdout).toContain(`✔ pre-commit ${shown} updated\n`)
    expect(lstatSync(hook).isSymbolicLink()).toBe(true)
    expect(project.read('scripts/pre-commit')).toBe(`#!/bin/sh\n${line}\nnpm test\n`)
    expect(statSync(hook).mode & 0o777).toBe(0o755)

    project.remove(HOOK)
    symlinkSync('../../scripts/later', hook)

    expect((await prepare()).stdout).toContain(`✔ pre-commit ${shown} created\n`)
    expect(lstatSync(hook).isSymbolicLink()).toBe(true)
    expect(project.read('scripts/later')).toBe(`${HEADER}${line}\n`)
    expect(statSync(hook).mode & 0o777).toBe(0o755)
  })
})

it('swaps in the new hook whole, so a commit already running it finishes the old one', async () => {
  const project = createProject('monorepo', { tools: [] })
  const go = project.path('go')
  const runner = fakeRunner(project, 'npx', `while [ ! -e "${go}" ]; do sleep 0.05; done\n`)
  const log = join(runner.bin, 'log')

  await project.run(['prepare', '--pre-commit'])
  await project.run(['prepare', '--pre-commit'], { cwd: 'packages/app' })

  const running = spawn('sh', [HOOK], {
    cwd: project.root,
    env: { ...project.env, ...runner.env },
    stdio: 'ignore',
  })
  const exited = once(running, 'exit')

  onTestFinished(() => writeFileSync(go, ''))

  await vi.waitFor(() => expect(readFileSync(log, 'utf8')).not.toBe(''), { timeout: 10_000 })

  const updated = await project.run(['prepare', '--pre-commit', '--only=oxlint'])

  writeFileSync(go, '')

  expect(updated.stdout).toContain(`✔ pre-commit ${HOOK} updated\n`)
  expect((await exited)[0]).toBe(0)
  expect(runner.ran()).toEqual([
    `${project.root} --no uncheck staged --fix`,
    `${project.root}/packages/app --no uncheck staged --fix`,
  ])
})
