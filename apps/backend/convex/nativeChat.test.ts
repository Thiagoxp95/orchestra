import { describe, expect, it } from 'bun:test'
import { enqueue } from './nativeChat'
type Row = { _id: string; sessionId?: string; command?: { kind: string }; status?: string; error?: string; priority?: number; updatedAt?: number }
function fixture() {
  const rows = new Map<string, Row>()
  const ctx = { db: {
    query(table: string) {
      let sessionId: string | undefined
      const query = {
        withIndex(_name: string, select: (q: { eq(key: string, value: string): unknown }) => unknown) { const builder = { eq(key: string, value: string) { if (key === 'sessionId') sessionId = value; return builder } }; select(builder); return query },
        unique: async () => table === 'authSessions' ? { token: 'ok' } : null,
        collect: async () => [...rows.values()].filter(row => !sessionId || row.sessionId === sessionId),
      }; return query
    },
    insert: async (_table: string, row: Omit<Row, '_id'>) => { const id = `c${rows.size}`; rows.set(id, { _id: id, ...row }); return id },
    patch: async (id: string, patch: Partial<Row>) => { Object.assign(rows.get(id)!, patch) },
  } }
  type Handler = { _handler(ctx: unknown, args: unknown): Promise<unknown> }
  return { rows, enqueue: (args: unknown) => (enqueue as unknown as Handler)._handler(ctx, args) }
}
describe('native chat durable remote commands', () => {
  it('Stop cancels same-session pending inputs and leaves receipts observable', async () => {
    const f = fixture()
    const id = await f.enqueue({ token: 'ok', sessionId: 's', command: { kind: 'send', text: 'queued' } })
    await f.enqueue({ token: 'ok', sessionId: 'other', command: { kind: 'send', text: 'other' } })
    await f.enqueue({ token: 'ok', sessionId: 's', command: { kind: 'interrupt' } })
    expect(f.rows.get(id as string)?.status).toBe('failed')
    expect(f.rows.get(id as string)?.error).toBe('Cancelled by Stop')
    expect([...f.rows.values()].find(r => r.sessionId === 'other')?.status).toBe('pending')
    expect([...f.rows.values()].find(r => r.command?.kind === 'interrupt')?.priority).toBe(0)
  })
  it('remote sends cannot read arbitrary host file paths', async () => {
    const f = fixture()
    await expect(f.enqueue({ token: 'ok', sessionId: 's', command: { kind: 'send', text: 'x', images: ['/private/file'] } })).rejects.toThrow(/uploaded images/)
    expect(f.rows.size).toBe(0)
  })
  it('retains image-only input until the host resolves upload paths', async () => {
    const f = fixture()
    await f.enqueue({ token: 'ok', sessionId: 's', command: { kind: 'send', text: '' }, uploads: [{ storageId: 'storage1', mime: 'image/png' }] })
    expect([...f.rows.values()][0].command?.kind).toBe('send')
  })
})
