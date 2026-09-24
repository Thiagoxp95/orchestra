import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), save: vi.fn(), records: [] as unknown[],
  createOrAttach: vi.fn(), listSessions: vi.fn(), ps: '', aiPid: undefined as number | undefined, transcripts: new Set(['12345678-abcd-abcd-abcd-123456789012']), settings: undefined as { agentSessionView?: string } | undefined,
}))
vi.mock('../persistence', () => ({ getStoreFilePath: () => '/tmp/orchestra-test/data.json', loadPersistedData: () => ({ sessions: {}, settings: mocks.settings }) }))
vi.mock('./store', () => ({ NativeChatStore: class { load() { return mocks.records }; save(record: unknown) { mocks.save(structuredClone(record)) } } }))
const adapter = () => ({ open: mocks.open, close: mocks.close, send: vi.fn(), configure: vi.fn(), compact: vi.fn(), interrupt: vi.fn(), respond: vi.fn() })
vi.mock('./codex', () => ({ createCodexAdapter: adapter }))
vi.mock('./claude', () => ({ createClaudeAdapter: adapter }))
vi.mock('./cursor', () => ({ createCursorAdapter: adapter }))
vi.mock('./cursor-bridge', () => ({ exportAcpChatToTerminal: vi.fn(async () => true) }))
vi.mock('../daemon-client', () => ({ getDaemonClient: () => ({ createOrAttach: mocks.createOrAttach, listSessions: mocks.listSessions }) }))
vi.mock('../resume-transcript', () => ({ findClaudeTranscriptById: (id: string) => (mocks.transcripts.has(id) ? `/t/${id}.jsonl` : null) }))
vi.mock('../process-monitor', () => ({ getSessionAiPid: () => mocks.aiPid }))
vi.mock('node:child_process', () => ({ execFile: (_cmd: string, _args: string[], cb: (e: null, r: { stdout: string }) => void) => cb(null, { stdout: mocks.ps }) }))
const session = { id: 's', cwd: '/work', processStatus: 'claude', initialCommand: 'claude --model opus --effort high --dangerously-skip-permissions' }
async function load(working = false) {
  const service = await import('./service')
  service.configureNativeChatHost({
    session: id => (id === 's' ? session as never : undefined),
    isWorking: () => working,
    changed: () => {},
    conversation: () => ({ agent: 'claude', resumeSessionId: '12345678-abcd-abcd-abcd-123456789012' }),
    selection: () => ({ model: 'sonnet' }),
  })
  return service
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.records = []; mocks.aiPid = undefined; mocks.settings = undefined
  mocks.listSessions.mockResolvedValue([{ sessionId: 's', isAlive: true, pid: 100 }])
  mocks.ps = '100 1 -zsh'
})
describe('chat ⇄ terminal handoff', () => {
  it('archived records stay terminal-owned and refuse chat commands', async () => {
    mocks.records = [{ snapshot: { sessionId: 's', provider: 'claude', cwd: '/work', settings: {}, revision: 1, status: 'idle', requests: [] }, history: [], receipts: [], terminalMigrated: true }]
    const service = await load()
    expect(service.nativeChatSnapshot('s')?.view).toBe('terminal')
    await expect(service.executeNativeChat('s', { kind: 'send', text: 'hi' })).rejects.toThrow('Switch it to chat')
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('stops the CLI and opens the same conversation with its model and trust level', async () => {
    mocks.aiPid = 4242
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const service = await load()
    const snapshot = await service.setNativeChatView('s', 'chat')
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(mocks.open).toHaveBeenCalledWith({ cwd: '/work', conversationId: '12345678-abcd-abcd-abcd-123456789012', settings: { model: 'sonnet', effort: 'high', permissionMode: 'bypass' } })
    expect(snapshot?.view).toBe('chat')
    expect(service.nativeChatActive('s')).toBe(true)
    kill.mockRestore()
  })
  it('starts a fresh chat when the CLI never wrote its transcript (brand-new session)', async () => {
    mocks.transcripts.clear()
    const service = await load()
    await service.setNativeChatView('s', 'chat')
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ conversationId: undefined }))
    mocks.transcripts.add('12345678-abcd-abcd-abcd-123456789012')
  })
  it('refuses to cut a CLI turn in half', async () => {
    const service = await load(true)
    await expect(service.setNativeChatView('s', 'chat')).rejects.toThrow('mid-turn')
    expect(service.nativeChatSnapshot('s')).toBeNull()
  })
  it('hands the conversation back to the terminal and resumes it there', async () => {
    const service = await load()
    await service.setNativeChatView('s', 'chat')
    const snapshot = await service.setNativeChatView('s', 'terminal')
    expect(mocks.close).toHaveBeenCalled()
    expect(snapshot?.view).toBe('terminal')
    expect(service.nativeChatRecord('s')?.terminalMigrated).toBe(false)
    expect(mocks.createOrAttach).toHaveBeenCalledWith('s', expect.objectContaining({ cwd: '/work' }))
    await expect(service.executeNativeChat('s', { kind: 'send', text: 'hi' })).rejects.toThrow('Switch it to chat')
  })
  it('opens a brand-new agent launch straight in chat, with its launch model/effort/trust', async () => {
    const service = await load()
    expect(service.startSessionInChat('n', '/work', 'claude --model opus --effort high --dangerously-skip-permissions')).toBe(true)
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledWith({ cwd: '/work', settings: { model: 'opus', effort: 'high', permissionMode: 'bypass' } }))
    expect(service.nativeChatActive('n')).toBe(true)
  })
  it('leaves the launch to the terminal when the user prefers it, or for resumes and custom commands', async () => {
    const service = await load()
    expect(service.startSessionInChat('a', '/work', 'claude --resume 12345678-abcd-abcd-abcd-123456789012')).toBe(false)
    expect(service.startSessionInChat('b', '/work', 'claude "fix the tests"')).toBe(false)
    mocks.settings = { agentSessionView: 'terminal' }
    expect(service.startSessionInChat('c', '/work', 'claude')).toBe(false)
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
