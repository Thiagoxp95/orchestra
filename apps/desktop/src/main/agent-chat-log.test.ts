import { describe, expect, it } from 'vitest'
import { AgentChatLog, type ChatLogEvent } from './agent-chat-log'
import type { ChatMessage } from './agent-message-model'

function msg(uid: string, text = uid): ChatMessage {
  return { uid, role: 'assistant', blocks: [{ kind: 'text', text }], ts: 1 }
}

describe('AgentChatLog', () => {
  it('stamps ascending seqs and reads them back above a cursor', () => {
    const log = new AgentChatLog()
    log.append('s1', [msg('a'), msg('b')])
    const rows = log.since('s1', -1)
    expect(rows.map((r) => r.uid)).toEqual(['a', 'b'])
    expect(rows[1].seq).toBeGreaterThan(rows[0].seq)
    expect(log.since('s1', rows[0].seq).map((r) => r.uid)).toEqual(['b'])
  })

  it('upserts by uid and KEEPS the stored seq', () => {
    // A re-attach replays the same records; re-stamping them would shuffle the
    // conversation under a reader that already holds them.
    const log = new AgentChatLog()
    log.append('s1', [msg('a', 'first'), msg('b')])
    const originalSeq = log.since('s1', -1)[0].seq
    log.append('s1', [msg('a', 'edited')])
    const rows = log.since('s1', -1)
    expect(rows).toHaveLength(2)
    expect(rows[0].seq).toBe(originalSeq)
    expect(rows[0].blocks).toEqual([{ kind: 'text', text: 'edited' }])
  })

  it('never rewinds seq across a clear', () => {
    // The pane holds its cursor through an untrack/retrack (and through a
    // conversation swap). Rows landing at or below it would never reach it.
    const log = new AgentChatLog()
    log.append('s1', [msg('a')])
    const before = log.since('s1', -1)[0].seq
    log.clear('s1')
    log.append('s1', [msg('b')])
    expect(log.since('s1', -1)[0].seq).toBeGreaterThan(before)
  })

  it('caps a session at 400 rows, evicting the oldest', () => {
    const log = new AgentChatLog()
    log.append(
      's1',
      Array.from({ length: 450 }, (_, i) => msg(`m${i}`)),
    )
    const rows = log.since('s1', -1)
    expect(rows).toHaveLength(400)
    expect(rows[0].uid).toBe('m50')
    expect(rows[399].uid).toBe('m449')
  })

  it('pages history below a seq, oldest first', () => {
    const log = new AgentChatLog()
    log.append(
      's1',
      Array.from({ length: 10 }, (_, i) => msg(`m${i}`)),
    )
    const all = log.since('s1', -1)
    const page = log.before('s1', all[5].seq, 3)
    expect(page.map((r) => r.uid)).toEqual(['m2', 'm3', 'm4'])
  })

  it('keeps sessions apart', () => {
    const log = new AgentChatLog()
    log.append('s1', [msg('a')])
    log.append('s2', [msg('b')])
    log.clear('s1')
    expect(log.since('s1', -1)).toEqual([])
    expect(log.since('s2', -1).map((r) => r.uid)).toEqual(['b'])
  })

  it('emits appends and clears to subscribers', () => {
    const log = new AgentChatLog()
    const seen: ChatLogEvent[] = []
    const off = log.subscribe((e) => seen.push(e))
    log.append('s1', [msg('a')])
    log.clear('s1')
    off()
    log.append('s1', [msg('b')])
    expect(seen.map((e) => e.kind)).toEqual(['append', 'clear'])
    expect(seen[0].kind === 'append' && seen[0].messages[0].uid).toBe('a')
  })

  it('survives a throwing listener', () => {
    // A renderer that has gone away must not stop the transcript tailer.
    const log = new AgentChatLog()
    log.subscribe(() => {
      throw new Error('window closed')
    })
    expect(() => log.append('s1', [msg('a')])).not.toThrow()
    expect(log.since('s1', -1)).toHaveLength(1)
  })
})
