import { spawn } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

import type { Project, RunResult } from '../_shared/project'

/** The payload Claude Code sends a Stop hook at the end of a turn. */
export const CLAUDE_STOP = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false })

interface ShellOptions {
  /** Where to run, relative to the top of the project. */
  readonly cwd?: string
  readonly stdin?: string
}

/** Runs a command line through `sh -c` in the project, the way an agent runs a hook command. */
export function sh(
  project: Project,
  command: string,
  { cwd = '.', stdin = '' }: ShellOptions = {},
) {
  return collect(
    spawn('sh', ['-c', command], { cwd: project.path(cwd), env: project.env, stdio: 'pipe' }),
    (child) => child.stdin.end(stdin),
  )
}

interface TerminalOptions {
  /** Where to run, relative to the top of the project. */
  readonly cwd?: string
  /** What to wait for on the terminal before typing `keys`. */
  readonly prompt?: string
  /** Keystrokes typed one after another once `prompt` shows. */
  readonly keys?: ReadonlyArray<string>
}

/**
 * Runs `uncheck <args>` with a terminal on stdin and stdout: `script` gives it a pty, and what is
 * typed into `script` reaches it as keystrokes. Linux only (util-linux `script`).
 */
export function inTerminal(
  project: Project,
  args: ReadonlyArray<string>,
  { cwd = '.', prompt, keys = [] }: TerminalOptions = {},
) {
  const command = [process.execPath, project.path('node_modules/uncheck/bin.mjs'), ...args]
    .map((part) => `'${part}'`)
    .join(' ')
  const child = spawn('script', ['-qec', command, '/dev/null'], {
    cwd: project.path(cwd),
    env: { ...project.env, SHELL: '/bin/sh', TERM: 'xterm' },
    stdio: 'pipe',
  })
  let typed = prompt === undefined

  return collect(
    child,
    () => {},
    (output) => {
      if (!typed && stripVTControlCharacters(output).includes(prompt!)) {
        typed = true
        void typeKeys(child.stdin, keys)
      }
    },
  )
}

async function typeKeys(stdin: NodeJS.WritableStream, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    stdin.write(key)
  }
}

function collect(
  child: ReturnType<typeof spawn>,
  start: (child: ReturnType<typeof spawn> & { stdin: NodeJS.WritableStream }) => void,
  onOutput: (output: string) => void = () => {},
) {
  return new Promise<RunResult>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout!.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      onOutput(Buffer.concat(stdout).toString())
    })
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      child.stdin!.destroy()
      resolve({
        code,
        signal,
        stdout: stripVTControlCharacters(Buffer.concat(stdout).toString()),
        stderr: stripVTControlCharacters(Buffer.concat(stderr).toString()),
      })
    })
    start(child as never)
  })
}

const CONFIGS = {
  claude: ['.claude/settings.json', (config: any) => config.hooks.Stop[0].hooks[0].command],
  codebuddy: ['.codebuddy/settings.json', (config: any) => config.hooks.Stop[0].hooks[0].command],
  cursor: ['.cursor/hooks.json', (config: any) => config.hooks.stop[0].command],
  copilot: ['.github/hooks/uncheck.json', (config: any) => config.hooks.agentStop[0].bash],
} as const

/** The command line an agent's config runs, as the agent reads it. */
export function hookOf(project: Project, agent: keyof typeof CONFIGS, dir = '.'): string {
  const [file, command] = CONFIGS[agent]

  return command(JSON.parse(project.read(`${dir}/${file}`)))
}
