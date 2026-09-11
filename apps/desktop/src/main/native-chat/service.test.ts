import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), records: [] as unknown[] }))
vi.mock('../persistence', () => ({ getStoreFilePath: () => '/tmp/orchestra-test/data.json', loadPersistedData: () => ({ sessions: {} }) }))
vi.mock('./store', () => ({ NativeChatStore: class { load() { return mocks.records }; save(record: unknown) { mocks.save(record) } } }))
vi.mock('./codex', () => ({ createCodexAdapter: () => ({ open: mocks.open }) }))
vi.mock('./claude', () => ({ createClaudeAdapter: () => ({ open: mocks.open }) }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.records = [] })
describe('retired native chat boundary', () => {
  it('rejects stale native commands without creating an SDK owner', async () => {
    const service = await import('./service')
    for (const command of [{ kind: 'start' }, { kind: 'send', text: 'hello' }, { kind: 'interrupt' }]) {
      await expect(service.executeNativeChat('session', command)).rejects.toThrow('retired')
    }
    expect(service.nativeChatSnapshot('session')).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects stale image sends before downloading an attachment', async () => {
    const service = await import('./service')
    const download = vi.fn()
    await expect(service.prepareNativeChatSend('session', { kind: 'send', text: '' }, 'operation', [{ storageId: 'image', mime: 'image/png' }], download)).rejects.toThrow('retired')
    expect(download).not.toHaveBeenCalled()
  })
  it('keeps original history and migration markers when a terminal is closed', async () => {
    mocks.records = [{ snapshot: { sessionId: 's', provider: 'claude', cwd: '/work', settings: {}, revision: 1, status: 'idle', requests: [] }, history: [{ uid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'old' }] }], receipts: [], terminalMigrated: true }]
    const service = await import('./service')
    expect(service.nativeChatManager().history('s')).toHaveLength(1)
    await service.stopNativeChat('s')
    expect(service.nativeChatSnapshot('s')).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
