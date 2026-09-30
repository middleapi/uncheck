import type { Files, Layout, Project, RunResult, Tool } from '../_shared/project'
import { createProject } from '../_shared/project'

export const NOT_COVERED = 'no tsconfig.json covers the given files'
// oxlint-disable-next-line no-template-curly-in-string
export const CONFIG_DIR = '${configDir}'

/**
 * A `typescript` package whose `tsc` only echoes its arguments, so plans over synthetic configs
 * run without real type errors getting in the way.
 */
export const FAKE_TYPESCRIPT: Files = {
  'node_modules/typescript/package.json': { name: 'typescript', bin: { tsc: 'tsc.js' } },
  'node_modules/typescript/tsc.js': "console.log(['tsc', ...process.argv.slice(2)].join(' '))\n",
}

export interface TscProjectOptions {
  /** Files written relative to the top of the repository rather than the app package. */
  readonly top?: Files
  readonly tools?: ReadonlyArray<Tool>
  readonly git?: boolean
  /** Install the echoing `typescript` package, on by default. */
  readonly fake?: boolean
}

/**
 * A fixture project whose app package (the top of the single package, `packages/app` in the
 * monorepo) holds `files`, with the fixture's own tsconfig of that package removed unless `files`
 * writes one.
 */
export function tscProject(
  layout: Layout,
  files: Files,
  { top = {}, tools = [], git, fake = true }: TscProjectOptions = {},
): Project {
  const appDir = layout === 'single' ? '' : 'packages/app/'
  const inApp = Object.fromEntries(
    Object.entries({ 'tsconfig.json': null, 'src': null, ...files }).map(([file, content]) => [
      `${appDir}${file}`,
      content,
    ]),
  )

  return createProject(layout, {
    tools,
    git,
    files: { ...(fake ? FAKE_TYPESCRIPT : {}), ...inApp, ...top },
  })
}

export interface Plan {
  /** The tsc command lines, `-b ...` or `-p ... --noEmit`, or the reason tsc did not run. */
  readonly tsc: ReadonlyArray<string> | string
  readonly result: RunResult
}

/**
 * Runs `uncheck --only=tsc [files]`, in the app package unless told otherwise. Missing files are
 * created empty first, since uncheck only takes paths that exist.
 */
export async function runPlan(
  project: Project,
  files: ReadonlyArray<string> = [],
  cwd: string = project.appDir,
): Promise<Plan> {
  // uncheck only takes paths that exist, so the ones a scenario only names are created empty.
  project.write(
    Object.fromEntries(
      files
        .map((file) => (cwd === '' ? file : `${cwd}/${file}`))
        .filter((file) => !project.exists(file))
        .map((file) => [file, '']),
    ),
  )

  const result = await project.run(['--only=tsc', ...files], { cwd })
  const lines = result.stdout.split('\n')
  const commands = lines.filter((line) => line.startsWith('▶ tsc ')).map((line) => line.slice(6))

  if (commands.length > 0) {
    return { tsc: commands, result }
  }

  const reason = lines
    .map((line) => /^(?:○ tsc skipped, |✘ tsc )(.*)$/.exec(line)?.[1])
    .find((match) => match !== undefined)

  return { tsc: reason ?? `unexpected output:\n${result.stdout}${result.stderr}`, result }
}

/** The tsc command lines of `runPlan`, or the reason tsc did not run. */
export async function plan(
  project: Project,
  files: ReadonlyArray<string> = [],
  cwd?: string,
): Promise<ReadonlyArray<string> | string> {
  return (await runPlan(project, files, cwd)).tsc
}

/** Whether a tsc project of the app package covers each file, planned one at a time in parallel. */
export async function coverage(
  project: Project,
  files: ReadonlyArray<string>,
): Promise<Record<string, boolean>> {
  const plans = await Promise.all(files.map((file) => plan(project, [file])))

  return Object.fromEntries(
    files.map((file, index) => {
      const planned = plans[index]!

      if (typeof planned === 'string' && planned !== NOT_COVERED) {
        throw new Error(`planning ${file} failed: ${planned}`)
      }

      return [file, Array.isArray(planned)]
    }),
  )
}
