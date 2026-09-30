import { writeFileSync } from 'node:fs'

import { LAYOUTS, report } from '../utils/project'
import { folderOf, inIndex, stagePartially, startUncheck, VERSIONS } from './utils'

describe.each(LAYOUTS)('uncheck staged interrupted in a $name', ({ create, app }) => {
  const folder = folderOf(app)
  const file = `${app}src/extra.ts`

  it('puts the unstaged changes back when a closed terminal hangs up during a slow check', async () => {
    const project = stagePartially(create({ [file]: VERSIONS.committed }), file)

    project.fake('oxlint', "console.log('waiting')\nsetTimeout(() => process.exit(1), 60_000)\n")

    const started = startUncheck(project, ['staged', '--only=oxlint'], { cwd: folder })

    await started.printed('waiting')
    started.child.kill('SIGHUP')
    started.child.kill('SIGHUP')

    const { exitCode, stdout } = await started.exited

    expect(exitCode).toBe(130)
    expect(report(stdout)).toEqual([
      `uncheck staged in ${project.path(folder)}`,
      '○ unstaged changes of src/extra.ts set aside until the checks finish',
      '○ sherif skipped, not selected by --only',
      '▶ oxlint --no-error-on-unmatched-pattern src/extra.ts',
      '○ unstaged changes of src/extra.ts restored',
    ])
    expect(project.read(file)).toBe(VERSIONS.unstaged)
    expect(inIndex(project, file)).toBe(VERSIONS.staged)
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
