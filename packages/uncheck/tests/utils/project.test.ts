import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Project, temporaryDirectory } from './project'

describe('test projects', () => {
  it('change nothing through a link to a folder outside their temporary folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'uncheck-outside-'))
    const manifest = join(outside, 'package.json')

    onTestFinished(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(manifest, '{}\n')
    chmodSync(manifest, 0o644)

    const project = new Project(temporaryDirectory()).link('linked', outside)

    expect(() => project.write({ 'linked/dist/cli.js': '' })).toThrow(' is outside ')
    expect(() => project.write({ 'linked/package.json': null })).toThrow(' is outside ')
    expect(() => project.chmod('linked/package.json', 0o600)).toThrow(' is outside ')
    expect(() => project.link('linked/bin/cli', 'cli.js')).toThrow(' is outside ')

    project.write({ linked: null })

    expect(project.exists('linked')).toBe(false)
    expect(readdirSync(outside)).toEqual(['package.json'])
    expect(statSync(manifest).mode & 0o7777).toBe(0o644)
  })
})
