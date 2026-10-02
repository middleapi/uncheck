import { readFileSync, writeFileSync } from 'node:fs'

import { LAYOUTS, report, wrappedGit } from '../utils/project'
import {
  expectRestored,
  folderOf,
  inIndex,
  stagePartially,
  startGit,
  startUncheck,
  VERSIONS,
} from './utils'

const SLOW_CHECK = "console.log('waiting')\nsetTimeout(() => process.exit(1), 60_000)\n"

describe.each(LAYOUTS)('uncheck staged interrupted in a $name', ({ create, app, tsc }) => {
  const folder = folderOf(app)
  const file = `${app}src/extra.ts`

  it('puts the unstaged changes back when a closed terminal hangs up twice during a slow check', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)
    const hungUp = project.path('.git/hung-up')

    project.fake('oxlint', SLOW_CHECK)

    // Two hang-ups sent back to back arrive as one, so the second comes from inside the merge that
    // puts the changes back, the only hash-object call with --path.
    const started = startUncheck(project, ['staged', '--only=oxlint'], {
      cwd: folder,
      env: wrappedGit(
        `case " $* " in *" hash-object "*" --path="*) echo $PPID >'${hungUp}'; kill -HUP $PPID; sleep 1;; esac`,
      ),
    })

    await started.printed('waiting')
    started.child.kill('SIGHUP')

    const { exitCode, stdout } = await started.exited

    expect(readFileSync(hungUp, 'utf8')).toBe(`${started.child.pid}\n`)
    expect(exitCode).toBe(130)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ unstaged changes of src/extra.ts set aside until the checks finish',
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --no-error-on-unmatched-pattern src/extra.ts',
      '○ unstaged changes of src/extra.ts restored',
    ])
    expectRestored(project, file)
  })

  it('puts the unstaged changes back after Ctrl-C during a slow check', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    project.fake('oxlint', SLOW_CHECK)

    const { exitCode } = await project.uncheckInTerminal(['staged', '--only=oxlint'], {
      cwd: folder,
      answers: [{ waitFor: 'waiting', keys: ['\u0003'] }],
    })

    expect(exitCode).toBe(130)
    expectRestored(project, file)
  })

  it('puts the unstaged changes back over a clashing fix after Ctrl-C before the fixes are staged', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)
    const clashing = VERSIONS.fixed.replace('const e = 1', 'const e = 3')

    project.fake(
      'oxfmt',
      `require('node:fs').writeFileSync(${JSON.stringify(project.path(file))}, ${JSON.stringify(clashing)})\n${SLOW_CHECK}`,
    )

    const { exitCode, stdout } = await project.uncheckInTerminal(
      ['staged', '--fix', '--only=oxfmt'],
      { cwd: folder, answers: [{ waitFor: 'waiting', keys: ['\u0003'] }] },
    )

    expect(exitCode).toBe(130)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ unstaged changes of src/extra.ts set aside until the checks finish',
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts',
    ])
    expectRestored(project, file)
  })

  it('puts the unstaged changes back as they were after Ctrl-C kills `git commit --include` and its index', async () => {
    const other = `${app}src/other.ts`
    const project = stagePartially(
      create({ [file]: VERSIONS.committed, [other]: 'export const other = 1;\n' }),
      file,
    )
      .write({
        [other]: 'export const other = 2;\n',
        '.git/hooks/pre-commit': `#!/bin/sh\n(cd "./${app}" && pnpm exec uncheck staged --fix --only=oxfmt --only=tsc) || exit 1\n`,
      })
      .chmod('.git/hooks/pre-commit', 0o755)
      .fake('typescript', SLOW_CHECK)

    const commit = startGit(project, ['commit', '--include', '--message=include', '--', other])

    await commit.printed('waiting')
    commit.interrupt()

    const { signal, stderr } = await commit.exited

    expect(signal).toBe('SIGINT')
    expect(report(stderr)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ unstaged changes of src/extra.ts set aside until the checks finish',
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '▶ oxfmt --no-error-on-unmatched-pattern src/extra.ts src/other.ts',
      '✔ oxfmt passed',
      tsc,
      '○ unstaged changes of src/extra.ts restored',
    ])
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(project.read(other)).toBe('export const other = 2;\n')
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
    expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n M ${other}\n`)
    expect(project.git('log', '--format=%s')).toBe('init\n')
    expect(project.exists('.git/index.lock')).toBe(false)
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })

  it('puts the unstaged changes back when nothing reads its output any more', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)
    const go = project.path('.git/go')

    project.fake(
      'oxlint',
      `const { existsSync } = require('node:fs')\nconsole.log('waiting')\nconst wait = () => (existsSync(${JSON.stringify(go)}) ? console.log('done') : setTimeout(wait, 10))\nwait()\nsetTimeout(() => process.exit(1), 60_000).unref()\n`,
    )

    const started = startUncheck(project, ['staged', '--fix', '--only=oxlint'], { cwd: folder })

    await started.printed('waiting')
    started.child.stdout.destroy()
    started.child.stderr.destroy()
    writeFileSync(go, '')

    const { exitCode } = await started.exited

    expect(exitCode).toBe(0)
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(project.git('status', '--porcelain')).toBe(`MM ${file}\n`)
    expect(project.exists('.git/uncheck-unstaged')).toBe(false)
  })
})
