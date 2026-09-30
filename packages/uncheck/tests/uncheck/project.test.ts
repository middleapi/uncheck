import { LAYOUTS, report } from '../utils/project'

describe.each(LAYOUTS)('uncheck in a $name', ({ create }) => {
  it('passes a clean project', async () => {
    const project = create()

    const { exitCode, stdout, stderr } = await project.uncheck()

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(report(stdout).at(-1)).toMatch(/^✔ all checks passed/)
  })
})
