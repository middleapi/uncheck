import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'

import { LAYOUTS, monorepo } from '../utils/project'
import { COMMAND, HEADER, hookLine, notWritten, prepare, shownHook, written } from './utils'

const HOOK = '.git/hooks/pre-commit'

describe.each(LAYOUTS)('prepare with an existing hook in a $name', ({ create, app }) => {
  const line = hookLine(app)
  const folder = app.slice(0, -1)

  async function prepareHook(hook: string) {
    const project = create().write({ [HOOK]: hook })

    const run = await prepare(project, [], { cwd: app })

    return { ...run, project, hook: project.read(HOOK) }
  }

  it('rewrites the line an older version wrote in place', async () => {
    const old =
      app === '' ? 'npx uncheck staged --fix' : `cd "${folder}" && yarn uncheck staged --fix`

    const { stdout, hook, project } = await prepareHook(`${HEADER}${old}\npnpm test\n`)

    expect(stdout).toBe(written(shownHook(project, app), 'updated'))
    expect(hook).toBe(`${HEADER}${line}\npnpm test\n`)
  })

  it('drops the copies of its line and settles on one', async () => {
    const copies = [
      line,
      app === '' ? 'uncheck staged' : `(cd "${folder}" && npx --no uncheck staged)`,
      app === '' ? 'bunx uncheck staged --only=oxfmt' : `cd "${folder}" && bunx uncheck staged`,
    ]

    const { stdout, hook, project } = await prepareHook(
      `${HEADER}${copies.join('\npnpm test\n')}\n`,
    )

    expect(stdout).toBe(written(shownHook(project, app), 'updated'))
    expect(hook).toBe(`${HEADER}${line}\npnpm test\npnpm test\n`)

    const again = await prepare(project, [], { cwd: app })

    expect(again.stdout).toBe(written(shownHook(project, app), 'unchanged'))
  })

  it('leaves alone the lines that only mention the command or run it another way', async () => {
    const others = [
      'echo "runs uncheck staged"',
      'npx uncheck staged --only=oxfmt && pnpm test',
      'pnpm exec uncheck staged --fix || echo "not blocking"',
      'pnpm exec uncheck staged src/index.ts',
      'pnpm exec uncheck stagedly',
      'pnpm dlx uncheck staged',
    ]

    const { hook } = await prepareHook(`#!/bin/sh\n${others.join('\n')}\n`)

    expect(hook).toBe(`#!/bin/sh\n${line}\n${others.join('\n')}\n`)
  })

  it('runs before the commands of the hook and after its setup', async () => {
    const setup = [
      '#!/usr/bin/env bash',
      '# lint before committing',
      '',
      'set -e',
      'unset GIT_INDEX_FILE',
      'export HOOKS="$(dirname "$0")"',
      'source ~/.profile',
      '. "$HOOKS/env"',
      '\\. "$HOOKS/nvm.sh"',
      '[ -f "$HOOKS/local" ] && . "$HOOKS/local"',
      'test -s "$HOOKS/path" && source "$HOOKS/path"',
      'NODE_OPTIONS=--max-old-space-size=4096',
    ].join('\n')
    const commands = 'export CI=1 && exec pnpm lint-staged\npnpm test\n'

    const { hook } = await prepareHook(`${setup}\n${commands}`)

    expect(hook).toBe(`${setup}\n${line}\n${commands}`)
  })

  it('runs after the setup of husky 8, whose script runs the hook again', async () => {
    const setup = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\n'

    const { hook } = await prepareHook(`${setup}npx lint-staged\n`)

    expect(hook).toBe(`${setup}${line}\nnpx lint-staged\n`)
  })

  it.each([
    ['a trailing backslash', 'export PATH=/opt/bin:\\\n/usr/bin:$PATH\n'],
    ['an open double quote', 'MESSAGE="checks\n. before committing"\n'],
    ['an open single quote', "MESSAGE='checks\n. before committing'\n"],
  ])('runs before a setup line continued by %s', async (_, setup) => {
    const { hook } = await prepareHook(`#!/bin/sh\n${setup}npx lint-staged\n`)

    expect(hook).toBe(`#!/bin/sh\n${line}\n${setup}npx lint-staged\n`)
  })

  it.each([
    ['an odd single quote', "# don't commit secrets"],
    ['an odd double quote', '# the "main branch'],
    ['a trailing backslash', '# see C:\\'],
  ])('runs after a setup comment with %s, which continues nothing', async (_, comment) => {
    const { hook } = await prepareHook(`#!/bin/sh\n${comment}\nnpx lint-staged\n`)

    expect(hook).toBe(`#!/bin/sh\n${comment}\n${line}\nnpx lint-staged\n`)
  })

  it('goes at the end of a hook that only sets up', async () => {
    const { hook } = await prepareHook('#!/bin/sh\n# nothing yet\n')

    expect(hook).toBe(`#!/bin/sh\n# nothing yet\n${line}\n`)
  })

  it('ends a hook without a trailing newline before adding its line', async () => {
    const { hook } = await prepareHook('#!/bin/sh\n# nothing yet')

    expect(hook).toBe(`#!/bin/sh\n# nothing yet\n${line}\n`)
  })

  it('keeps a hook without a trailing newline as it is around its line', async () => {
    const { hook } = await prepareHook('#!/bin/sh\necho "checking"')

    expect(hook).toBe(`#!/bin/sh\n${line}\necho "checking"`)
  })

  it('fills an empty hook with its line alone', async () => {
    const { stdout, hook, project } = await prepareHook('')

    expect(stdout).toBe(written(shownHook(project, app), 'updated'))
    expect(hook).toBe(`${line}\n`)
    expect(project.mode(HOOK)).toBe(0o755)
  })

  it('leaves a hook in another language alone and says what it should run', async () => {
    const script = '#!/usr/bin/env python3\nprint("checked")\n'

    const { exitCode, stdout, hook, project } = await prepareHook(script)

    expect(exitCode).toBe(0)
    expect(stdout).toBe(
      notWritten(
        shownHook(project, app),
        `it is not a shell script, have it run \`${line}\` yourself`,
      ),
    )
    expect(hook).toBe(script)
  })

  it.each([
    ['invalid UTF-8', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0xff, 0xfe])],
    ['a NUL byte', Buffer.from('#!/bin/sh\necho "\0"\n')],
  ])('leaves a hook with %s alone', async (_, bytes) => {
    const project = create()
    writeFileSync(project.path(HOOK), bytes)

    const { stdout } = await prepare(project, [], { cwd: app })

    expect(stdout).toBe(
      notWritten(
        shownHook(project, app),
        `it is not a shell script, have it run \`${line}\` yourself`,
      ),
    )
    expect(readFileSync(project.path(HOOK))).toEqual(bytes)
  })
})

describe('prepare with an existing hook in a monorepo', () => {
  it('puts the line of a new package after the lines of the others', async () => {
    const root = hookLine('')
    const core = hookLine('packages/core/', `${COMMAND} --only=oxlint`)
    const project = monorepo().write({
      [HOOK]: `#!/bin/sh\nexport CI=1\n${root}\n${core}\npnpm test\n`,
    })

    await prepare(project, [], { cwd: 'packages/app' })

    expect(project.read(HOOK)).toBe(
      `#!/bin/sh\nexport CI=1\n${root}\n${core}\n${hookLine('packages/app/')}\npnpm test\n`,
    )
  })

  it('rewrites the lines older versions wrote for the other packages', async () => {
    const project = monorepo().write({
      [HOOK]: [
        '#!/bin/sh',
        'pnpm exec uncheck staged --fix',
        'pnpm test',
        'cd "packages/core" && pnpm exec uncheck staged --fix --only=oxlint',
        'cd "packages/app" && pnpm exec uncheck staged --fix',
        '',
      ].join('\n'),
    })

    const { stdout } = await prepare(project, ['--no-fix'], { cwd: 'packages/app' })

    expect(stdout).toBe(written(project.path(HOOK), 'updated', 'pnpm exec uncheck staged'))
    expect(project.read(HOOK)).toBe(
      [
        '#!/bin/sh',
        'pnpm exec uncheck staged --fix || exit 1',
        'pnpm test',
        '(cd "packages/core" && pnpm exec uncheck staged --fix --only=oxlint) || exit 1',
        '(cd "packages/app" && pnpm exec uncheck staged) || exit 1',
        '',
      ].join('\n'),
    )
  })
})
