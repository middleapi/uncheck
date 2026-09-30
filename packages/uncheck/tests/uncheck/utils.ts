import type { Project } from '../utils/project'

export interface LayoutChecks {
  readonly sherif: ReadonlyArray<string>
  readonly tsc: string
  readonly checks: ReadonlyArray<string>
}

export function layoutChecks(app: string, { fix = false } = {}): LayoutChecks {
  return app === ''
    ? {
        sherif: ['○ sherif skipped, not a workspace root'],
        tsc: '▶ tsc -p tsconfig.json --noEmit',
        checks: ['oxlint', 'oxfmt', 'tsc'],
      }
    : {
        sherif: [fix ? '▶ sherif --fix --select=highest' : '▶ sherif', '✔ sherif passed'],
        tsc: '▶ tsc -b tsconfig.json',
        checks: ['sherif', 'oxlint', 'oxfmt', 'tsc'],
      }
}

export function updateJson(
  project: Project,
  file: string,
  update: (value: Record<string, unknown>) => object,
): Project {
  return project.write({
    [file]: update(JSON.parse(project.read(file)) as Record<string, unknown>),
  })
}
