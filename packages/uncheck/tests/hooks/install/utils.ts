export const TIMEOUT = 600

export function hookCommand(app: string, flags: ReadonlyArray<string> = []): string {
  const dir = app === '' ? [] : [`--dir=${app.slice(0, -1)}`]

  return ['pnpm exec uncheck hooks run --fix', ...flags, ...dir].join(' ')
}

export function installOutput(results: ReadonlyArray<string>, command: string): string {
  return `${results.map((result) => `✔ ${result}\n`).join('')}\nThe hook runs ${command} whenever the agent finishes a turn.\n`
}

export function claudeSettings(command: string) {
  return { hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: TIMEOUT }] }] } }
}

export function cursorHooks(command: string) {
  return { version: 1, hooks: { stop: [{ command, timeout: TIMEOUT }] } }
}

export function copilotHooks(command: string) {
  return {
    version: 1,
    hooks: {
      agentStop: [{ type: 'command', bash: command, powershell: command, timeoutSec: TIMEOUT }],
    },
  }
}

export function asWritten(config: object): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
