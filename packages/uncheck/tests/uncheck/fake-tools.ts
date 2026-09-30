import { spawn } from 'node:child_process'
import process from 'node:process'

import type { Files, Project } from '../_shared/project'
import { formatJson, uncheckBin } from '../_shared/project'

/**
 * The files of a tool package whose bin runs `script`, for what a real tool cannot show: its
 * arguments, its environment, a crash or a slow run. Install it only in a project created without
 * the real tool, whose `node_modules/<name>` is a link into the shared store.
 */
export function fakeTool(
  name: string,
  script: string,
  bin: unknown = { [name]: 'bin.js' },
  dir = 'node_modules',
): Files {
  return {
    [`${dir}/${name}/package.json`]: formatJson({ name, bin }),
    [`${dir}/${name}/bin.js`]: script,
  }
}

/** Prints the arguments it got, one line per run, for `toolArgs` to read back. */
export const ECHO = "console.log('ARGS ' + JSON.stringify(process.argv.slice(2)))\n"

/** The arguments every run of an `ECHO` tool got, one list per run. */
export function toolArgs(stdout: string): string[][] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('ARGS '))
    .map((line) => JSON.parse(line.slice(5)) as string[])
}

export interface SpawnedCli {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** As printed, ANSI styling included. */
  readonly stdout: string
  readonly stderr: string
}

export interface SpawnCliOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** A command the bin runs under, such as `setpriv` with its arguments. */
  readonly wrap?: ReadonlyArray<string>
  /** Called on every chunk of stdout with everything printed so far. */
  readonly onStdout?: (stdout: string, kill: (signal: NodeJS.Signals) => void) => void
  /** Closes the reading ends of stdout and stderr right away, as `| head` does once it has enough. */
  readonly closePipes?: boolean
}

/** Runs the installed bin like `project.run` does, with a handle on the process and its raw output. */
export function spawnCli(
  project: Project,
  args: ReadonlyArray<string>,
  { cwd = '.', env = {}, wrap = [], onStdout, closePipes = false }: SpawnCliOptions = {},
): Promise<SpawnedCli> {
  return new Promise((resolve, reject) => {
    const [command = process.execPath, ...prefix] =
      wrap.length > 0 ? [...wrap, process.execPath] : []
    const child = spawn(command, [...prefix, uncheckBin(project), ...args], {
      cwd: project.path(cwd),
      env: { ...project.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    if (closePipes) {
      child.stdout.destroy()
      child.stderr.destroy()
    } else {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        onStdout?.(stdout, (signal) => child.kill(signal))
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
    }

    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}
