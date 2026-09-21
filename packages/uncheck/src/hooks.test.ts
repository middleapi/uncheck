import { stopAgent } from './hooks'

describe('stopAgent', () => {
  it('recognizes each agent family from the fields it documents', () => {
    expect(stopAgent({ hook_event_name: 'Stop', session_id: 'x', stop_hook_active: false })).toBe('claude')
    expect(stopAgent({ hook_event_name: 'Stop', generation_id: 'x', stop_hook_active: true })).toBe('claude')
    expect(stopAgent({ hook_event_name: 'stop', status: 'completed', loop_count: 0 })).toBe('cursor')
    expect(stopAgent({ sessionId: 'x', stopReason: 'end_turn', stop_hook_active: false })).toBe('copilot')
    expect(stopAgent({ agent_action_name: 'post_cascade_response', tool_info: {} })).toBeUndefined()
    expect(stopAgent({})).toBeUndefined()
  })
})
