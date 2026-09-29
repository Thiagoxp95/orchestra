import { describe, expect, it, vi } from 'vitest'

const sent: Array<[string, string, any]> = []

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))
vi.mock('../persistence', () => ({ loadPersistedData: () => ({ workspaces: {} }) }))
vi.mock('../terminal-output-buffer', () => ({ hasRecentTerminalOutput: () => false }))
vi.mock('../daemon-client', () => ({
  getDaemonClient: () => ({
    getSnapshot: async () => ({ snapshotAnsi: '$ echo hi\r\nhi\r\n\x1b[1mbold\x1b[0m\r\n', cols: 40, rows: 5 }),
  }),
}))
vi.mock('./api', () => ({ sendRemoteCommand: async (...args: [string, string, any]) => void sent.push(args) }))
vi.mock('./runtime-state', () => ({
  getRemoteState: () => ({
    workspaces: [{ id: 'w1', name: 'W', activeTreeIndex: 0, customActions: [], trees: [{ rootDir: '/r', sessionIds: ['s1'] }] }],
    sessions: { s1: { label: 'Terminal', processStatus: 'terminal' } },
    liveStatus: {},
    activeWorkspaceId: 'w1',
    activeSessionId: 's1',
  }),
}))

const { handleMcpMessage } = await import('./mcp')
const call = (name: string, args: object) =>
  handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

describe('mcp', () => {
  it('speaks the handshake', async () => {
    const init = await handleMcpMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(init?.result.protocolVersion).toBe('2025-03-26')
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const list = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list?.result.tools.map((t: any) => t.name)).toContain('send_input')
  })

  it('renders the terminal as plain text', async () => {
    const res = await call('read_terminal', { sessionId: 's1' })
    expect(res?.result.content[0].text).toBe('[work: idle]\n$ echo hi\nhi\nbold')
  })

  it('types text, keys one per write, then Enter', async () => {
    sent.length = 0
    await call('send_input', { sessionId: 's1', text: 'ls', keys: ['ctrl-c', 'up'] })
    expect(sent.map(([, , p]) => p.data)).toEqual(['ls', '\x03', '\x1b[A', '\r'])
  })

  it('reports bad input as a tool error', async () => {
    expect((await call('send_input', { sessionId: 'nope' }))?.result.isError).toBe(true)
    expect((await call('send_input', { sessionId: 's1', keys: ['hyper'] }))?.result.isError).toBe(true)
  })
})
