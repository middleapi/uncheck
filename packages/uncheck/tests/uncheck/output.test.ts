import { availableParallelism } from 'node:os'
import { stripVTControlCharacters, styleText } from 'node:util'

import { LAYOUTS, report, singleRepo } from '../utils/project'
import { layoutChecks } from './utils'

const STANDALONE_TSCONFIG = {
  compilerOptions: {
    strict: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    types: [],
    noEmit: true,
  },
}

const PRINT_FORCE_COLOR = "console.log('the tool sees FORCE_COLOR=' + process.env.FORCE_COLOR);\n"

const STANDALONE_PROJECTS = [1, 2, 3, 4, 5].map((index) => `project-${index}`)

function countConcurrentRuns(cap: number, total: number): string {
  return `const { mkdirSync, readdirSync, renameSync, writeFileSync } = require('node:fs');

const config = process.argv[process.argv.indexOf('-p') + 1];
const marker = config.replaceAll('/', '_');
const count = (dir) => readdirSync(dir).length;
const giveUp = Date.now() + 10_000;
let most = 0;

mkdirSync('running', { recursive: true });
mkdirSync('finished', { recursive: true });
writeFileSync(\`running/\${marker}\`, '');

(function waitForOthers() {
  const running = count('running');
  most = Math.max(most, running);

  if (running === ${cap} || running + count('finished') === ${total}) {
    console.log(\`\${config} saw \${most} running\`);
    renameSync(\`running/\${marker}\`, \`finished/\${marker}\`);
  } else if (Date.now() > giveUp) {
    console.log(\`\${config} gave up with \${running} running\`);
  } else {
    setTimeout(waitForOthers, 10);
  }
})();
`
}

function paint(style: Parameters<typeof styleText>[0], text: string): string {
  return styleText(style, text, { validateStream: false })
}

describe.each(LAYOUTS)('uncheck output in a $name', ({ create, app }) => {
  const { sherif, checks } = layoutChecks(app)

  it('fails a check whose tool is killed by a signal and still runs the others', async () => {
    const project = create().fake('oxlint', "process.kill(process.pid, 'SIGKILL');\n")

    const { exitCode, stdout } = await project.uncheck(['--skip=tsc'])

    expect(stdout).toMatch(
      /^▶ oxlint\nProcess interrupted due to receipt of signal: 'SIGKILL'\n✘ oxlint failed /m,
    )
    expect(report(stdout)).toEqual([
      `uncheck in ${project.dir}`,
      ...sherif,
      '▶ oxlint',
      '✘ oxlint failed',
      '▶ oxfmt --check',
      '✔ oxfmt passed',
      '○ tsc skipped, disabled with --skip=tsc',
      `✘ 1 of ${checks.length - 1} checks failed: oxlint`,
      '  rerun with `--fix` to apply oxlint fixes',
    ])
    expect(exitCode).toBe(1)
  })

  it('prints the output of standalone projects one project after the other', async () => {
    const project = create({
      [`${app}scripts/tsconfig.json`]: STANDALONE_TSCONFIG,
      [`${app}scripts/check.ts`]: 'export const scripts: number = "1";\n',
      [`${app}tools/tsconfig.json`]: STANDALONE_TSCONFIG,
      [`${app}tools/check.ts`]: 'export const tools: number = "2";\n',
    })

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

    const lines = stdout
      .split('\n')
      .filter((line) => line.startsWith('▶ ') || line.includes('error TS'))
      .map((line) => line.replace(/\(\d+,\d+\): error (TS\d+).*$/, ' $1'))

    expect(lines).toEqual([
      ...(app === '' ? [] : ['▶ tsc -b tsconfig.json']),
      `▶ tsc -p ${app}scripts/tsconfig.json --noEmit`,
      `${app}scripts/check.ts TS2322`,
      `▶ tsc -p ${app}tools/tsconfig.json --noEmit`,
      `${app}tools/check.ts TS2322`,
      ...(app === '' ? ['▶ tsc -p tsconfig.json --noEmit'] : []),
    ])
    expect(report(stdout).at(-1)).toBe('✘ 1 of 1 checks failed: tsc')
    expect(exitCode).toBe(1)
  })
})

describe('uncheck output', () => {
  it.skipIf(availableParallelism() < 2)(
    'checks standalone projects side by side without mixing their output',
    async () => {
      const project = singleRepo({
        'scripts/tsconfig.json': STANDALONE_TSCONFIG,
        'scripts/check.ts': 'export const scripts = 1;\n',
      }).fake(
        'typescript',
        `const { existsSync, writeFileSync } = require('node:fs');

const config = process.argv[process.argv.indexOf('-p') + 1];
const other = config === 'tsconfig.json' ? 'scripts/tsconfig.json' : 'tsconfig.json';
const giveUp = Date.now() + 10_000;

console.log(\`\${config} started\`);
writeFileSync(\`\${config}.started\`, '');

(function waitForOther() {
  if (existsSync(\`\${other}.started\`)) {
    console.log(\`\${config} saw \${other} running\`);
  } else if (Date.now() > giveUp) {
    console.log(\`\${config} ran alone\`);
  } else {
    setTimeout(waitForOther, 10);
  }
})();
`,
      )

      const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

      expect(stdout).toMatch(
        /^▶ tsc -p scripts\/tsconfig\.json --noEmit\nscripts\/tsconfig\.json started\nscripts\/tsconfig\.json saw tsconfig\.json running\n▶ tsc -p tsconfig\.json --noEmit\ntsconfig\.json started\ntsconfig\.json saw scripts\/tsconfig\.json running\n✔ tsc passed /m,
      )
      expect(exitCode).toBe(0)
    },
  )

  it('runs at most four type checkers at once and prints their output in order', async () => {
    const cap = Math.min(4, availableParallelism())
    const project = singleRepo(
      Object.fromEntries(
        STANDALONE_PROJECTS.flatMap((name) => [
          [`${name}/tsconfig.json`, STANDALONE_TSCONFIG],
          [`${name}/check.ts`, 'export const value = 1;\n'],
        ]),
      ),
    ).fake('typescript', countConcurrentRuns(cap, STANDALONE_PROJECTS.length + 1))

    const { exitCode, stdout } = await project.uncheck(['--only=tsc'])

    const runs = [...stdout.matchAll(/^▶ tsc -p (\S+) --noEmit\n\1 saw (\d+) running$/gm)]

    expect(runs.map(([, config]) => config)).toEqual([
      ...STANDALONE_PROJECTS.map((name) => `${name}/tsconfig.json`),
      'tsconfig.json',
    ])
    expect(Math.max(...runs.map(([, , most]) => Number(most)))).toBe(cap)
    expect(report(stdout).at(-1)).toBe('✔ all checks passed (tsc)')
    expect(exitCode).toBe(0)
  })

  it('shows how long a slow check took in seconds', async () => {
    const project = singleRepo().fake('oxlint', 'setTimeout(() => {}, 1100);\n')

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint'])

    expect(stdout).toMatch(/^✔ oxlint passed \d+\.\ds$/m)
    expect(exitCode).toBe(0)
  })

  it('styles its lines and asks tools for colors when FORCE_COLOR is set', async () => {
    const project = singleRepo().fake('oxfmt', PRINT_FORCE_COLOR)

    const { exitCode, stdout } = await project.uncheck(['--only=oxfmt'], {
      env: { FORCE_COLOR: '1' },
    })

    expect(stdout).toContain(
      `${paint('dim', '○')} ${paint('bold', 'sherif')} ${paint('dim', 'skipped, not selected by --only')}\n`,
    )
    expect(stdout).toContain(
      `${paint('dim', '▶')} ${paint('bold', 'oxfmt')} ${paint('dim', '--check')}\nthe tool sees FORCE_COLOR=1\n`,
    )
    expect(stdout).toContain(
      `${paint('green', '✔')} ${paint('bold', 'oxfmt')} ${paint('green', 'passed')} `,
    )
    expect(stdout).toContain(`${paint('green', '✔')} all checks passed (oxfmt)\n`)
    expect(report(stripVTControlCharacters(stdout)).at(-1)).toBe('✔ all checks passed (oxfmt)')
    expect(exitCode).toBe(0)
  })

  it('styles failures in red', async () => {
    const project = singleRepo({ 'src/legacy.ts': 'var count = 1;\nexport { count };\n' })

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint', '--require=oxlint'], {
      env: { FORCE_COLOR: '1' },
    })

    expect(stdout).toContain(
      `${paint('red', '✘')} ${paint('bold', 'oxlint')} ${paint('red', 'failed')} `,
    )
    expect(stdout).toContain(`${paint('red', '✘')} 1 of 1 checks failed: oxlint\n`)
    expect(stdout).toContain(paint('dim', '  rerun with `--fix` to apply oxlint fixes'))
    expect(exitCode).toBe(1)
  })

  it('asks tools for colors when it prints to a terminal', async () => {
    const project = singleRepo().fake('oxlint', PRINT_FORCE_COLOR)

    // Node paints nothing in a terminal whose TERM is unset, which it is in some shells.
    const { exitCode, stdout } = await project.uncheckInTerminal(['--only=oxlint'], {
      env: { TERM: 'xterm-256color' },
    })

    expect(stdout).toContain('\nthe tool sees FORCE_COLOR=1\n')
    expect(report(stdout).at(-1)).toBe('✔ all checks passed (oxlint)')
    expect(exitCode).toBe(0)
  })

  it('leaves tools without colors when it prints to a pipe', async () => {
    const project = singleRepo().fake('oxlint', PRINT_FORCE_COLOR)

    const { exitCode, stdout } = await project.uncheck(['--only=oxlint'])

    expect(stdout).toContain('▶ oxlint\nthe tool sees FORCE_COLOR=undefined\n')
    expect(stdout).not.toContain('\u001B[')
    expect(exitCode).toBe(0)
  })
})
