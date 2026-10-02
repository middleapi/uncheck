import type { Env, Project, Run } from '../../utils/project'
import { temporaryDirectory } from '../../utils/project'

export const CLAUDE_CODE_STOP = {
  session_id: 'session',
  hook_event_name: 'Stop',
  stop_hook_active: false,
}

export const CLAUDE_CODE_STOP_AGAIN = { ...CLAUDE_CODE_STOP, stop_hook_active: true }

export const CURSOR_STOP = {
  conversation_id: 'conversation',
  hook_event_name: 'stop',
  status: 'completed',
  loop_count: 0,
}

export const COPILOT_AGENT_STOP = {
  sessionId: 'session',
  stopReason: 'end_turn',
  stop_hook_active: false,
}

export const COPILOT_STOP_IN_CLAUDE_FORMAT = {
  hook_event_name: 'Stop',
  stop_reason: 'end_turn',
  stop_hook_active: false,
}

export const TYPE_ERROR = 'export const answer: string = 1;\n'

export const UTILS_NOT_FOUND =
  "src/index.ts(1,24): error TS2307: Cannot find module './utils' or its corresponding type declarations."

// uncheck remembers the turns it blocked in the temporary folder, which would keep a file of every test run.
const MARKERS = temporaryDirectory()

export function hookEnv(env?: Env): Env {
  return { TMPDIR: MARKERS, ...env }
}

export function dirFlags(app: string): string[] {
  return app === '' ? [] : [`--dir=${app.slice(0, -1)}`]
}

interface HookOptions {
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Env
}

export function stopHook(
  project: Project,
  app: string,
  payload: object | string,
  { args = ['--fix'], cwd, env }: HookOptions = {},
): Promise<Run> {
  return project.uncheck(['hooks', 'run', ...dirFlags(app), ...args], {
    cwd,
    env: hookEnv(env),
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}
