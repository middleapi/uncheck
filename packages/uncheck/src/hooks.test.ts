import { extractHookPaths } from './hooks'

describe('extractHookPaths', () => {
  it('finds the edited file in every agent payload shape', () => {
    expect(
      extractHookPaths({
        hook_event_name: 'PostToolUse',
        transcript_path: '/tmp/transcript.jsonl',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' },
        tool_response: { filePath: '/repo/src/a.ts', success: true },
      }),
    ).toEqual(['/repo/src/a.ts'])

    expect(extractHookPaths({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/nb.ipynb' } })).toEqual([
      '/repo/nb.ipynb',
    ])

    expect(
      extractHookPaths({ hook_event_name: 'afterFileEdit', file_path: '/repo/src/b.ts', workspace_roots: ['/repo'] }),
    ).toEqual(['/repo/src/b.ts'])

    expect(
      extractHookPaths({ agent_action_name: 'post_write_code', tool_info: { file_path: '/repo/src/c.py', edits: [] } }),
    ).toEqual(['/repo/src/c.py'])

    expect(extractHookPaths({ toolName: 'edit', toolArgs: { path: 'src/d.ts', command: 'str_replace' } })).toEqual([
      'src/d.ts',
    ])
  })

  it('returns nothing for payloads without file paths', () => {
    expect(extractHookPaths({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual([])
    expect(extractHookPaths(undefined)).toEqual([])
    expect(extractHookPaths('not json')).toEqual([])
  })
})
