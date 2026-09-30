import { LAYOUTS, monorepo, report } from '../utils/project'
import { layoutChecks } from './utils'

const ONLY_FILE_CHECKS = ['--only=oxlint', '--only=oxfmt']

const YARN_PNP_RESOLVER = `const Module = require('node:module');
const path = require('node:path');

process.versions.pnp = '3';

const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  return request === 'oxlint/package.json'
    ? path.join(__dirname, '.yarn/unplugged/oxlint/package.json')
    : resolveFilename.call(this, request, ...rest);
};
`

describe.each(LAYOUTS)('uncheck finding tools in a $name', ({ create, app }) => {
  const { sherif, tsc, checks } = layoutChecks(app)

  it('skips oxlint and oxfmt when they are not installed', async () => {
    const project = create({}, { tools: ['sherif', 'typescript'] })

    const { exitCode, stdout } = await project.uncheck()

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '○ oxlint skipped, not installed',
      '○ oxfmt skipped, not installed',
      tsc,
      '✔ tsc passed',
      `✔ all checks passed (${checks.filter((name) => name === 'sherif' || name === 'tsc').join(', ')})`,
    ])
    expect(exitCode).toBe(0)
  })

  it('runs a tool whose manifest names its only bin with a string', async () => {
    const project = create(
      {
        'node_modules/oxfmt/package.json': { name: 'oxfmt', bin: 'cli.js' },
        'node_modules/oxfmt/cli.js':
          "console.log('oxfmt ran with ' + process.argv.slice(2).join(' '));\n",
      },
      { tools: ['sherif', 'oxlint', 'typescript'] },
    )

    const { exitCode, stdout } = await project.uncheck(['--only=oxfmt'])

    expect(stdout).toContain('▶ oxfmt --check\noxfmt ran with --check\n')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not selected by --only',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxfmt)',
    ])
    expect(exitCode).toBe(0)
  })

  it.each([
    ['declares a bin for another command', { name: 'oxlint', bin: { oxc: 'bin.js' } }],
    ['declares no bin', { name: 'oxlint' }],
    ['is not JSON', '{ "name": "oxlint",\n'],
    ['is not an object', '"oxlint"\n'],
  ])('takes a tool whose manifest %s for not installed', async (_, manifest) => {
    const project = create(
      { 'node_modules/oxlint/package.json': manifest, 'node_modules/oxfmt/package.json': manifest },
      { tools: ['sherif', 'typescript'] },
    )

    const { exitCode, stdout } = await project.uncheck(ONLY_FILE_CHECKS)

    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not selected by --only',
      '○ oxlint skipped, not installed',
      '○ oxfmt skipped, not installed',
      '○ tsc skipped, not selected by --only',
      '✘ nothing to check: sherif not selected by --only, oxlint not installed, oxfmt not installed, tsc not selected by --only',
    ])
    expect(exitCode).toBe(1)
  })

  it('finds the tools installed above the folder it checks', async () => {
    const project = create()

    const { exitCode, stdout } = await project.uncheck(ONLY_FILE_CHECKS, { cwd: `${app}src` })

    expect(report(stdout)).toEqual([
      `uncheck in ${project.path(app, 'src')}`,
      '○ sherif skipped, not selected by --only',
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      '○ tsc skipped, not selected by --only',
      '✔ all checks passed (oxlint, oxfmt)',
    ])
    expect(exitCode).toBe(0)
  })

  it('finds a tool through the resolver of Yarn PnP', async () => {
    const project = create(
      {
        '.gitignore': 'node_modules\ndist\n.yarn\n.pnp.cjs\n',
        '.pnp.cjs': YARN_PNP_RESOLVER,
        '.yarn/unplugged/oxlint/package.json': { name: 'oxlint', bin: { oxlint: 'bin.js' } },
        '.yarn/unplugged/oxlint/bin.js': "console.log('oxlint from the Yarn cache');\n",
      },
      { tools: ['oxfmt', 'typescript'] },
    )

    const { exitCode, stdout } = await project.uncheck([], {
      env: { NODE_OPTIONS: `--require ${project.path('.pnp.cjs')}` },
    })

    expect(stdout).toContain('▶ oxlint\noxlint from the Yarn cache\n')
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      '○ sherif skipped, not installed',
      '▶ oxlint',
      '✔ oxlint passed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      tsc,
      '✔ tsc passed',
      '✔ all checks passed (oxlint, oxfmt, tsc)',
    ])
    expect(exitCode).toBe(0)
  })
})

describe('uncheck finding tools in a monorepo', () => {
  it('runs the tool installed nearest to the folder it checks', async () => {
    const project = monorepo({
      'packages/app/node_modules/oxlint/package.json': {
        name: 'oxlint',
        bin: { oxlint: 'bin.js' },
      },
      'packages/app/node_modules/oxlint/bin.js': "console.log('oxlint of packages/app');\n",
    })

    const inPackage = await project.uncheck(['--only=oxlint'], { cwd: 'packages/app' })

    expect(inPackage.stdout).toContain('▶ oxlint\noxlint of packages/app\n')
    expect(inPackage.exitCode).toBe(0)

    const atRoot = await project.uncheck(['--only=oxlint'])

    expect(atRoot.stdout).not.toContain('oxlint of packages/app')
    expect(atRoot.exitCode).toBe(0)
  })
})
