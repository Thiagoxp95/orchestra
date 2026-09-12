import { expect, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import * as remote from './remote'

type Row = { _id: string; sessionId?: string; seq?: number; createdAt?: number; [key: string]: unknown }
type Handler = { _handler(ctx: unknown, args: unknown): Promise<any> }
function database() {
  const tables = new Map<string, Row[]>([['ptyChunks', Array.from({ length: 6000 }, (_, seq) => ({ _id: `chunk-${seq}`, sessionId: 'session', seq, createdAt: 0, data: 'x' }))]])
  const jobs: { name: string; args: unknown }[] = []
  let operations = 0
  const budget = (n: number) => { operations += n; if (operations > 4096) throw new Error('Too many database operations') }
  function query(table: string) {
    const predicates: ((r: Row) => boolean)[] = []; let descending = false
    const range = {
      eq(k: string, v: unknown) { predicates.push(r => r[k] === v); return range },
      gt(k: string, v: number) { predicates.push(r => Number(r[k]) > v); return range },
      lte(k: string, v: number) { predicates.push(r => Number(r[k]) <= v); return range },
      lt(k: string, v: number) { predicates.push(r => Number(r[k]) < v); return range },
    }
    const read = (limit: number) => {
      let rows = (tables.get(table) ?? []).filter(r => predicates.every(p => p(r)))
      if (descending) rows = rows.toReversed()
      rows = rows.slice(0, limit); budget(rows.length); return rows
    }
    const q = {
      withIndex(_name: string, filter?: (r: typeof range) => unknown) { filter?.(range); return q },
      order(order: string) { descending = order === 'desc'; return q },
      filter() { return q },
      async take(n: number) { return read(n) }, async collect() { return read(Infinity) },
      async first() { return read(1)[0] ?? null }, async unique() { return read(1)[0] ?? null },
    }
    return q
  }
  const ctx = {
    db: {
      query, system: { query },
      async delete(id: string) { budget(1); for (const [name, rows] of tables) tables.set(name, rows.filter(r => r._id !== id)) },
      async insert(name: string, value: Row) { const row = { ...value, _id: `${name}-${tables.get(name)?.length ?? 0}` }; tables.set(name, [...tables.get(name) ?? [], row]); return row._id },
      async patch(id: string, value: Row) { for (const rows of tables.values()) for (const row of rows) if (row._id === id) Object.assign(row, value) },
    },
    scheduler: { async runAfter(_ms: number, ref: Parameters<typeof getFunctionName>[0], args: unknown) { jobs.push({ name: getFunctionName(ref).split(':')[1], args }) } },
    storage: { async delete() {} },
  }
  async function run(name: string, args: unknown) {
    operations = 0
    return (remote[name as keyof typeof remote] as unknown as Handler)._handler(ctx, args)
  }
  return { tables, jobs, run }
}

test('clearing a long terminal hides old output immediately and deletes it without touching the replacement seed', async () => {
  const previous = process.env.DEVICE_SECRET; process.env.DEVICE_SECRET = 'test-device'
  try {
    const d = database()
    d.tables.set('authSessions', [{ _id: 'auth', token: 'viewer' }])
    await d.run('clearChunks', { secret: 'test-device', sessionId: 'session' })
    expect(await d.run('getChunks', { token: 'viewer', sessionId: 'session', afterSeq: -1 })).toEqual([])
    expect(await d.run('headSeq', { secret: 'test-device', sessionId: 'session' })).toBe(5999)
    const seed = { _id: 'fresh-seed', sessionId: 'session', seq: 6000, data: 'current screen', seed: true }
    d.tables.get('ptyChunks')!.push(seed)
    expect(await d.run('getChunks', { token: 'viewer', sessionId: 'session', afterSeq: -1 })).toEqual([seed])
    for (let i = 0; d.jobs.length && i < 100; i++) { const job = d.jobs.shift()!; await d.run(job.name, job.args) }
    expect(d.jobs).toHaveLength(0)
    expect(d.tables.get('ptyChunks')).toEqual([seed])
  } finally { if (previous === undefined) delete process.env.DEVICE_SECRET; else process.env.DEVICE_SECRET = previous }
})

test('scheduled retention drains a large expired tail without exceeding one transaction budget', async () => {
  const d = database()
  await d.run('pruneRemote', {})
  for (let i = 0; d.jobs.length && i < 100; i++) { const job = d.jobs.shift()!; await d.run(job.name, job.args) }
  expect(d.jobs).toHaveLength(0)
  expect(d.tables.get('ptyChunks')).toEqual([])
})

test('repeated attaches share one cleanup worker per terminal', async () => {
  const previous = process.env.DEVICE_SECRET; process.env.DEVICE_SECRET = 'test-device'
  try {
    const d = database()
    for (let i = 0; i < 10; i++) await d.run('clearChunks', { secret: 'test-device', sessionId: 'session' })
    expect(d.jobs).toHaveLength(1)
  } finally { if (previous === undefined) delete process.env.DEVICE_SECRET; else process.env.DEVICE_SECRET = previous }
})

test('cron ticks cannot multiply an existing retention cleanup chain', async () => {
  const d = database()
  for (let i = 0; i < 10; i++) await d.run('pruneRemote', {})
  expect(d.jobs).toHaveLength(1)
})
