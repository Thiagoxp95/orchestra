import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const mirrorState = {
  workspaces: [
    {
      id: 'w1',
      name: 'W',
      activeTreeIndex: 0,
      customActions: [{ id: 'a1', name: 'Dev' }],
      trees: [{ rootDir: '/r', sessionIds: ['s1'] }] as { rootDir: string; sessionIds: string[] }[],
    },
  ],
  sessions: { s1: { label: 'Terminal', processStatus: 'terminal' } } as Record<string, any>,
  liveStatus: {},
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  updateStatus: {
    supported: true, state: 'downloaded', updateAvailable: true, updateDownloaded: true, currentVersion: '1.0.0',
    availableVersion: '1.0.1', percent: null, restartPending: false, message: null, releaseUrl: null,
  },
}

let spawned = 0

/** Stands in for the renderer: spawn commands add the sessions it would create. */
function simulateDesktop(kind: string, payload: any): void {
  const ws = mirrorState.workspaces[0]
  const add = (tree: { sessionIds: string[] }, id: string, processStatus: string) => {
    tree.sessionIds = [...tree.sessionIds, id] // the mirror publishes fresh arrays
    mirrorState.sessions[id] = { label: id, processStatus, origin: payload.origin }
  }
  if (kind === 'spawnInTree') add(ws.trees[payload.treeIndex], `new-${++spawned}`, payload.agent ?? 'terminal')
  if (kind === 'restartToUpdate' && mirrorState.updateStatus.updateDownloaded) mirrorState.updateStatus.restartPending = true
  if (kind === 'createWorkspace') {
    mirrorState.workspaces.push({ id: `ws-${++spawned}`, name: payload.name, activeTreeIndex: 0, customActions: [], trees: [{ rootDir: payload.rootDir, sessionIds: [] }] })
  }
  if (kind === 'updateWorkspace') Object.assign(mirrorState.workspaces.find((w) => w.id === payload.workspaceId)!, payload.updates)
  if (kind === 'deleteWorkspace') mirrorState.workspaces = mirrorState.workspaces.filter((w) => w.id !== payload.workspaceId)
  if (kind === 'saveAction' && !ws.customActions.some((a) => a.id === payload.action.id)) {
    ws.customActions = [...ws.customActions, { id: payload.action.id, name: payload.action.name }]
  }
  if (kind === 'createWorktree') {
    const tree = { rootDir: '/wt', sessionIds: [] as string[] }
    ws.trees.push(tree)
    add(tree, 'wt-terminal', 'terminal')
    add(tree, 'wt-agent', payload.spinUp)
  }
}

vi.mock('./api', () => ({
  sendRemoteCommand: async (...args: [string, string, any]) => {
    sent.push(args)
    simulateDesktop(args[0], args[2])
  },
}))
vi.mock('./runtime-state', () => ({ getRemoteState: () => mirrorState }))

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

  it('marks every session it spawns as origin mcp', async () => {
    sent.length = 0
    const opened = JSON.parse((await call('open_session', { workspaceId: 'w1', agent: 'claude' }))?.result.content[0].text)
    expect(mirrorState.sessions[opened.sessionId].origin).toBe('mcp')
    await call('run_action', { workspaceId: 'w1', actionId: 'a1' })
    await call('create_worktree', { workspaceId: 'w1', branch: 'b', spinUp: 'claude' })
    expect(sent.map(([kind, , p]) => [kind, p.origin])).toEqual([
      ['spawnInTree', 'mcp'],
      ['spawnInTree', 'mcp'],
      ['createWorktree', 'mcp'],
    ])
  })

  it("create_worktree returns the spun-up agent, not the tree's default terminal", async () => {
    const res = JSON.parse((await call('create_worktree', { workspaceId: 'w1', branch: 'c', spinUp: 'codex' }))?.result.content[0].text)
    expect(res.sessionId).toBe('wt-agent')
    expect(res.sessionIds).toEqual(['wt-terminal', 'wt-agent'])
  })

  it('get_state reports origin, defaulting to user', async () => {
    const state = JSON.parse((await call('get_state', {}))?.result.content[0].text)
    const byId = Object.fromEntries(state.workspaces[0].trees.flatMap((t: any) => t.sessions).map((s: any) => [s.id, s.origin]))
    expect(byId.s1).toBe('user')
    expect(byId['wt-agent']).toBe('mcp')
  })

  it('install_update restarts once into the downloaded version', async () => {
    sent.length = 0
    const text = async (name: string) => (await call(name, {}))?.result.content[0].text
    expect(JSON.parse(await text('update_status')).availableVersion).toBe('1.0.1')
    expect(await text('install_update')).toBe('Restarting 1.0.0 → 1.0.1.')
    expect(await text('install_update')).toBe('Already restarting into 1.0.1.')
    expect(sent.map(([kind]) => kind)).toEqual(['restartToUpdate'])
  })

  it('create_workspace makes and git-inits the folder once, then returns the same id', async () => {
    sent.length = 0
    const dir = join(mkdtempSync(join(tmpdir(), 'orchestra-mcp-')), 'New Thing')
    const first = JSON.parse((await call('create_workspace', { name: 'New Thing', rootDir: dir }))?.result.content[0].text)
    expect(first).toMatchObject({ created: true, rootDir: dir, gitInitialized: true })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    const again = JSON.parse((await call('create_workspace', { name: 'Other', rootDir: `${dir}/` }))?.result.content[0].text)
    expect(again).toEqual({ workspaceId: first.workspaceId, created: false, rootDir: dir })
    expect(sent).toEqual([['createWorkspace', '', { name: 'New Thing', rootDir: dir }]])
  })

  it('create_workspace leaves an existing repo alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestra-mcp-'))
    mkdirSync(join(dir, '.git'))
    const res = JSON.parse((await call('create_workspace', { name: 'Repo', rootDir: dir }))?.result.content[0].text)
    expect(res).toMatchObject({ created: true, gitInitialized: false })
    expect((await call('create_workspace', { name: ' ' }))?.result.isError).toBe(true)
  })

  it('updates a workspace and waits for the mirror', async () => {
    sent.length = 0
    expect((await call('update_workspace', { workspaceId: 'w1', name: 'Renamed', color: '#112233' }))?.result.content[0].text).toBe('ok')
    expect(sent).toEqual([['updateWorkspace', '', { workspaceId: 'w1', updates: { name: 'Renamed', color: '#112233' } }]])
    expect((await call('update_workspace', { workspaceId: 'w1', color: 'red' }))?.result.isError).toBe(true)
    expect((await call('update_workspace', { workspaceId: 'w1' }))?.result.isError).toBe(true)
  })

  it('creates, updates and deletes actions', async () => {
    sent.length = 0
    const created = JSON.parse((await call('create_action', { workspaceId: 'w1', name: 'Test', command: 'bun test' }))?.result.content[0].text)
    expect(mirrorState.workspaces[0].customActions.map((a) => a.id)).toContain(created.actionId)
    await call('update_action', { workspaceId: 'w1', actionId: created.actionId, runInBackground: true })
    await call('delete_action', { workspaceId: 'w1', actionId: created.actionId })
    expect(sent).toEqual([
      ['saveAction', '', { workspaceId: 'w1', action: { name: 'Test', command: 'bun test', id: created.actionId } }],
      ['saveAction', '', { workspaceId: 'w1', action: { runInBackground: true, id: created.actionId } }],
      ['deleteAction', '', { workspaceId: 'w1', actionId: created.actionId }],
    ])
    expect((await call('update_action', { workspaceId: 'w1', actionId: 'nope', name: 'x' }))?.result.isError).toBe(true)
    expect((await call('create_action', { workspaceId: 'w1', name: 'x', actionType: 'bash' }))?.result.isError).toBe(true)
  })

  it('relabels a worktree and moves a session', async () => {
    sent.length = 0
    await call('update_worktree', { workspaceId: 'w1', treeIndex: 0, displayName: 'main' })
    await call('update_session', { sessionId: 's1', move: 'down' })
    expect(sent).toEqual([
      ['updateWorktree', '', { workspaceId: 'w1', treeIndex: 0, displayName: 'main' }],
      ['moveSession', 's1', { sessionId: 's1', direction: 'down' }],
    ])
    expect((await call('update_worktree', { workspaceId: 'w1', treeIndex: 9, displayName: 'x' }))?.result.isError).toBe(true)
  })

  it('delete_workspace waits until it is gone', async () => {
    const created = JSON.parse((await call('create_workspace', { name: 'Doomed', rootDir: mkdtempSync(join(tmpdir(), 'orchestra-mcp-')) }))?.result.content[0].text)
    expect((await call('delete_workspace', { workspaceId: created.workspaceId }))?.result.content[0].text).toBe('Removed Doomed.')
    expect(mirrorState.workspaces.some((w) => w.id === created.workspaceId)).toBe(false)
  })

  it('reports bad input as a tool error', async () => {
    expect((await call('send_input', { sessionId: 'nope' }))?.result.isError).toBe(true)
    expect((await call('send_input', { sessionId: 's1', keys: ['hyper'] }))?.result.isError).toBe(true)
  })
})
