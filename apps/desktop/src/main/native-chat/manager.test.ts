import { describe, expect, it, vi } from 'vitest'
import { NativeChatManager, type NativeChatRecord } from './manager'
import type { NativeChatAdapter, ProviderEventSink } from './provider'
function fixture(saved: NativeChatRecord[] = []) {
  const records = new Map(saved.map(r => [r.snapshot.sessionId, structuredClone(r)]))
  let emit!: ProviderEventSink
  const adapter: NativeChatAdapter = {
    open: vi.fn(async () => { emit({ kind: 'conversation', conversationId: 'thread-1' }); emit({ kind: 'status', status: 'idle' }) }),
    send: vi.fn(async () => { emit({ kind: 'status', status: 'working' }) }),
    configure: vi.fn(async () => {}), compact: vi.fn(async () => { emit({ kind: 'status', status: 'compacting' }) }),
    interrupt: vi.fn(async () => { emit({ kind: 'status', status: 'idle' }) }),
    respond: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
  const save = vi.fn((r: NativeChatRecord) => { records.set(r.snapshot.sessionId, structuredClone(r)) })
  const manager = new NativeChatManager({ load: () => [...records.values()], save, factory: (_provider, sink) => { emit = sink; return adapter } })
  if (!manager.get('s')) manager.register({ sessionId: 's', provider: 'codex', cwd: '/work', settings: { model: 'test-model', effort: 'high' } })
  return { manager, records, adapter, save, event: (e: Parameters<ProviderEventSink>[0]) => emit(e) }
}
describe('native chat ownership', () => {
  it('persists provider identity and uses accepted settings on actual turns after restart', async () => {
    const first = fixture()
    await first.manager.execute('s', { kind: 'configure', settings: { effort: 'low' } })
    await first.manager.execute('s', { kind: 'send', text: 'hello' })
    expect(first.adapter.send).toHaveBeenCalledWith({ text: 'hello', images: [], settings: { model: 'test-model', effort: 'low' } })
    const next = fixture([...first.records.values()])
    await next.manager.execute('s', { kind: 'send', text: 'continue' })
    expect(next.adapter.open).toHaveBeenCalledWith({ cwd: '/work', conversationId: 'thread-1', settings: { model: 'test-model', effort: 'low' } })
  })
  it('does not persist settings a provider rejects', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'start' })
    vi.mocked(f.adapter.configure).mockRejectedValueOnce(new Error('unsupported effort'))
    await expect(f.manager.execute('s', { kind: 'configure', settings: { effort: 'max' } })).rejects.toThrow('unsupported effort')
    expect(f.records.get('s')!.snapshot.settings.effort).toBe('high')
  })
  it('restores the provider setting when durable commit fails', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'start' })
    f.save.mockImplementation(record => {
      if (record.snapshot.settings.effort === 'low') throw new Error('Disk full')
      f.records.set(record.snapshot.sessionId, structuredClone(record))
    })
    await expect(f.manager.execute('s', { kind: 'configure', settings: { effort: 'low' } })).rejects.toThrow('Disk full')
    expect(f.adapter.configure).toHaveBeenLastCalledWith({ model: 'test-model', effort: 'high' })
    expect(f.manager.get('s')!.settings.effort).toBe('high')
  })
  it('saves a model/effort switch made mid-turn and runs it on the next turn', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'send', text: 'first' })
    await f.manager.execute('s', { kind: 'configure', settings: { model: 'other', effort: 'low' } })
    expect(f.adapter.configure).not.toHaveBeenCalled()
    expect(f.records.get('s')!.snapshot.settings).toEqual({ model: 'other', effort: 'low' })
    f.event({ kind: 'status', status: 'idle' })
    await f.manager.execute('s', { kind: 'send', text: 'second' })
    expect(f.adapter.send).toHaveBeenLastCalledWith({ text: 'second', images: [], settings: { model: 'other', effort: 'low' } })
  })
  it('blocks overlapping turns, interrupts compaction and accepts the next send', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'compact' })
    await expect(f.manager.execute('s', { kind: 'send', text: 'too soon' })).rejects.toThrow(/busy/i)
    await f.manager.execute('s', { kind: 'interrupt' })
    await f.manager.execute('s', { kind: 'send', text: 'after compact' })
    expect(f.adapter.interrupt).toHaveBeenCalledTimes(1)
    expect(f.adapter.send).toHaveBeenCalledTimes(1)
  })
  it('replays receipts without repeating a provider side effect across restart', async () => {
    const first = fixture()
    await first.manager.execute('s', { kind: 'send', text: 'once' }, 'command-1')
    const second = fixture([...first.records.values()])
    await second.manager.execute('s', { kind: 'send', text: 'once' }, 'command-1')
    expect(second.adapter.send).not.toHaveBeenCalled()
    await expect(second.manager.execute('s', { kind: 'send', text: 'different' }, 'command-1')).rejects.toThrow(/different/i)
  })
  it('keeps durable replay protection beyond 100 operations', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'start' })
    for (let i = 0; i < 105; i++) await f.manager.execute('s', { kind: 'configure', settings: { model: `m${i}` } }, `op${i}`)
    await f.manager.execute('s', { kind: 'configure', settings: { model: 'm0' } }, 'op0')
    expect(f.adapter.configure).toHaveBeenCalledTimes(105)
    expect(f.manager.get('s')!.settings.model).toBe('m104')
  })
  it('does not replay an uncertain command after a crash', async () => {
    const first = fixture()
    vi.mocked(first.adapter.send).mockImplementation(() => new Promise(() => {}))
    void first.manager.execute('s', { kind: 'send', text: 'once' }, 'pending-1')
    await vi.waitFor(() => expect(first.adapter.send).toHaveBeenCalled())
    const second = fixture([...first.records.values()])
    await expect(second.manager.execute('s', { kind: 'send', text: 'once' }, 'pending-1')).rejects.toThrow(/unknown|uncertain/i)
    expect(second.adapter.send).not.toHaveBeenCalled()
  })
  it('routes requests by id and rejects obsolete replies', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'start' })
    f.event({ kind: 'request', request: { id: 'r1', kind: 'approval', title: 'Run command' } })
    await expect(f.manager.execute('s', { kind: 'respond', reply: { requestId: 'old', decision: 'allow' } })).rejects.toThrow(/no longer/i)
    await f.manager.execute('s', { kind: 'respond', reply: { requestId: 'r1', decision: 'deny' } })
    expect(f.adapter.respond).toHaveBeenCalledWith({ requestId: 'r1', decision: 'deny' })
  })
  it('ignores events from a closed provider owner', async () => {
    const f = fixture()
    await f.manager.execute('s', { kind: 'start' })
    await f.manager.stop('s')
    f.event({ kind: 'status', status: 'working' })
    expect(f.manager.get('s')!.status).toBe('stopped')
  })
})
