import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeChatStore } from './store'
import type { NativeChatRecord } from './manager'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-native-store-'))
  directories.push(directory)
  const record: NativeChatRecord = {
    snapshot: { sessionId: '../session', provider: 'codex', cwd: '/work', conversationId: 'thread-1', settings: { model: 'model-1', effort: 'high' }, view: 'chat', status: 'idle', requests: [], revision: 1 },
    history: [], receipts: [{ id: 'once', fingerprint: 'hash', status: 'accepted' }],
  }
  return { directory, record, store: new NativeChatStore(directory) }
}
describe('durable native conversation store', () => {
  it('replaces the same conversation atomically and restores identity, settings and receipts', () => {
    const { directory, record, store } = fixture()
    store.save(record)
    record.snapshot.settings.effort = 'low'
    record.snapshot.revision++
    store.save(record)
    expect(new NativeChatStore(directory).load()).toEqual([record])
    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(statSync(join(directory, files[0])).mode & 0o777).toBe(0o600)
  })
  it('ignores incomplete temporary writes while retaining the last committed record', () => {
    const { directory, record, store } = fixture()
    store.save(record)
    writeFileSync(join(directory, 'interrupted.json.tmp'), '{')
    expect(store.load()).toEqual([record])
  })
  it('fails explicitly on corrupt saved conversations instead of silently starting new ones', () => {
    const { directory, store } = fixture()
    writeFileSync(join(directory, 'broken.json'), JSON.stringify({ history: [], receipts: [] }))
    expect(() => store.load()).toThrow(/Cannot read saved native conversation/)
  })
})
