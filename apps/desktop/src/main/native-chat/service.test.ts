import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), kill: vi.fn(), create: vi.fn(), open: vi.fn(), send: vi.fn(), save: vi.fn(), records: [] as unknown[] }))
vi.mock('../persistence', () => ({ getStoreFilePath: () => '/tmp/orchestra-test/data.json', loadPersistedData: () => ({ sessions: {} }) }))
vi.mock('../daemon-client', () => ({ getDaemonClient: () => ({ listSessions: mocks.list, kill: mocks.kill, createOrAttach: mocks.create }) }))
vi.mock('./store', () => ({ NativeChatStore: class { load() { return mocks.records }; save(record: unknown) { mocks.save(record) } } }))
vi.mock('./codex', () => ({ createCodexAdapter: () => ({ open: mocks.open, close: async () => {}, interrupt: async () => {} }) }))
vi.mock('./claude', () => ({ createClaudeAdapter: () => ({ open: mocks.open, send: mocks.send, close: async () => {}, interrupt: async () => {} }) }))
const session = { id: 's', workspaceId: 'w', label: 'test', processStatus: 'claude' as const, cwd: '/work', shellPath: '/bin/zsh', resumeAgent: 'claude' as const, resumeSessionId: 'old-conversation' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.records = []; mocks.list.mockResolvedValue([{ sessionId: 's', isAlive: true }]); mocks.kill.mockResolvedValue(undefined); mocks.create.mockResolvedValue({}); mocks.open.mockResolvedValue(undefined) })
async function fixture(override = {}) {
  const service = await import('./service')
  service.configureNativeChatHost({ session: () => ({ ...session, ...override }), isWorking: () => false, changed: () => {} })
  return service
}
describe('native ownership handoff', () => {
  it('closing during discovery prevents a pending handoff from recreating the shell', async () => {
    const pending = deferred<{ sessionId: string; isAlive: boolean }[]>()
    mocks.list.mockReturnValue(pending.promise)
    const s = await fixture()
    const start = s.executeNativeChat('s', { kind: 'start' })
    const rejected = expect(start).rejects.toThrow(/cancel/i)
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled())
    await s.stopNativeChat('s')
    pending.resolve([])
    await rejected
    expect(s.nativeChatSnapshot('s')).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('replaying an accepted remote Stop does not cancel a newer image upload', async () => {
    const s = await fixture()
    await s.executeNativeChat('s', { kind: 'start' })
    const download = deferred<string>()
    const downloader = vi.fn(() => download.promise)
    await s.prepareNativeChatSend('s', { kind: 'interrupt' }, 'stop-1', [], downloader)
    const send = s.prepareNativeChatSend('s', { kind: 'send', text: 'new image' }, 'send-2', [{ storageId: 'image', mime: 'image/png' }], downloader)
    await vi.waitFor(() => expect(downloader).toHaveBeenCalledTimes(1))
    await s.prepareNativeChatSend('s', { kind: 'interrupt' }, 'stop-1', [], downloader)
    download.resolve('/tmp/image.png')
    await expect(send).resolves.toMatchObject({ sessionId: 's' })
    expect(mocks.send).toHaveBeenCalledWith({ text: 'new image', images: ['/tmp/image.png'], settings: {} })
  })
  it('Stop during legacy discovery cancels migration before killing anything', async () => {
    const pending = deferred<{ sessionId: string; isAlive: boolean }[]>()
    mocks.list.mockReturnValue(pending.promise)
    const s = await fixture()
    const start = s.executeNativeChat('s', { kind: 'start' })
    const rejected = expect(start).rejects.toThrow(/cancel/i)
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled())
    expect(await s.executeNativeChat('s', { kind: 'interrupt' })).toBeNull()
    pending.resolve([{ sessionId: 's', isAlive: true }])
    await rejected
    expect(mocks.kill).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('Stop during legacy termination prevents provider startup afterward', async () => {
    const pending = deferred<void>(); mocks.kill.mockReturnValue(pending.promise)
    const s = await fixture()
    const start = s.executeNativeChat('s', { kind: 'start' })
    const rejected = expect(start).rejects.toThrow(/cancel/i)
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalled())
    await s.executeNativeChat('s', { kind: 'interrupt' })
    pending.resolve()
    await rejected
    expect(s.nativeChatSnapshot('s')).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('concurrent starts perform one handoff and preserve exact provider conversation', async () => {
    const s = await fixture()
    await Promise.all([s.executeNativeChat('s', { kind: 'start' }), s.executeNativeChat('s', { kind: 'start' })])
    expect(mocks.kill).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(mocks.open).toHaveBeenCalledWith({ cwd: '/work', conversationId: 'old-conversation', settings: {} })
  })
  it('never resumes an earlier provider after the CLI has changed provider', async () => {
    const s = await fixture({ resumeAgent: 'codex' })
    await expect(s.executeNativeChat('s', { kind: 'start' })).rejects.toThrow(/conversation id/i)
    expect(mocks.kill).not.toHaveBeenCalled()
  })
  it('allows log observers to inspect native ownership during cold hydration', async () => {
    mocks.records = [{ snapshot: { sessionId: 's', provider: 'claude', cwd: '/work', settings: {}, revision: 1, status: 'idle', requests: [] }, history: [{ uid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'old' }] }], receipts: [] }]
    const s = await fixture()
    const { agentChatLog } = await import('../agent-chat-log')
    let calls = 0
    const off = agentChatLog.subscribe(() => { expect(s.nativeChatSnapshot('s')).not.toBeNull(); calls++ })
    expect(s.nativeChatSnapshot('s')?.status).toBe('stopped')
    expect(calls).toBe(1)
    off()
  })
})
