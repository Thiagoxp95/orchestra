import { describe, expect, it } from 'vitest'
import { PendingChatCommands } from './pending-chat-commands'

describe('PendingChatCommands', () => {
  it('prevents a second mount from resubmitting pending work', () => {
    const pending = new PendingChatCommands()
    const release = pending.start('a')
    expect(release).not.toBeNull()
    expect(pending.has('a')).toBe(true)
    expect(pending.start('a')).toBeNull()
    release!()
    expect(pending.has('a')).toBe(false)
  })

  it('notifies only the relevant subscribers and ignores an old completion', () => {
    const pending = new PendingChatCommands()
    const states: boolean[] = []
    const off = pending.subscribe('a', () => states.push(pending.has('a')))
    const first = pending.start('a')!
    const other = pending.start('b')!
    first()
    const second = pending.start('a')!
    first()
    expect(pending.has('a')).toBe(true)
    second()
    other()
    expect(states).toEqual([true, false, true, false])
    off()
    pending.start('a')!()
    expect(states).toEqual([true, false, true, false])
  })
})
