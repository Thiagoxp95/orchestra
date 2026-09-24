import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeChatRecord } from './manager'
/** Per-conversation atomic replacement, separate from renderer-owned workspace saves. */
export class NativeChatStore {
  constructor(private readonly directory: string) {}
  load(): NativeChatRecord[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => {
      const value = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as NativeChatRecord
      if (!value.snapshot?.sessionId || !['claude', 'codex', 'cursor'].includes(value.snapshot.provider) || !Array.isArray(value.history) || !Array.isArray(value.receipts)) {
        throw new Error(`Cannot read saved native conversation: ${name}`)
      }
      return value
    })
  }
  save(record: NativeChatRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const filename = createHash('sha256').update(record.snapshot.sessionId).digest('hex') + '.json'
    const target = join(this.directory, filename)
    const temporary = target + '.tmp'
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, target)
  }
}
