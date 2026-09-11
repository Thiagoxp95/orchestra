import { describe, expect, it } from 'bun:test'
import { pruneRemote } from './remote'

type Row = { _id: string; createdAt: number; native?: boolean }
type Filter = (row: Row) => boolean

describe('native conversation retention', () => {
  it('retains native history without starving expiry of legacy rows beyond the pruning page', async () => {
    const rows = new Map<string, Row>()
    for (let i = 0; i < 2100; i++) rows.set(`native-${i}`, { _id: `native-${i}`, createdAt: 1, native: true })
    rows.set('legacy-old', { _id: 'legacy-old', createdAt: 2 })
    rows.set('legacy-new', { _id: 'legacy-new', createdAt: Date.now() })
    const ctx = { db: {
      query(table: string) {
        const filters: Filter[] = []
        const builder = {
          eq(key: keyof Row, value: unknown) { filters.push(row => row[key] === value); return builder },
          lt(key: keyof Row, value: number) { filters.push(row => typeof row[key] === 'number' && Number(row[key]) < value); return builder },
        }
        const query = {
          withIndex(_name: string, select: (q: typeof builder) => unknown) { select(builder); return query },
          take: async (limit: number) => table === 'agentMessages' ? [...rows.values()].filter(row => filters.every(f => f(row))).slice(0, limit) : [],
        }
        return query
      },
      delete: async (id: string) => { rows.delete(id) },
      system: { query: () => ({ filter: () => ({ take: async () => [] }) }) },
    } }
    const mutation = pruneRemote as unknown as { _handler(ctx: unknown, args: unknown): Promise<void> }
    await mutation._handler(ctx, {})
    expect(rows.has('legacy-old')).toBe(false)
    expect(rows.has('legacy-new')).toBe(true)
    expect([...rows.values()].filter(row => row.native)).toHaveLength(2100)
  })
})
