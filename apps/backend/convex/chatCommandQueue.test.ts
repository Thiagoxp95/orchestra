import { describe, expect, it } from 'bun:test'
import { cancelPendingChatCommands, prioritizeCommands } from '../../desktop/src/shared/chat-command-queue'

describe('chat command queue', () => {
  it('includes an interrupt outside the ordinary 200-command page without duplicating rows', () => {
    const ordinary = Array.from({ length: 200 }, (_, i) => ({ _id: `cmd-${i}`, _creationTime: i }))
    const interrupt = { _id: 'stop', _creationTime: 300 }
    const delivered = prioritizeCommands(ordinary, [ordinary[3], interrupt])
    expect(delivered).toHaveLength(201)
    expect(delivered.at(-1)).toEqual(interrupt)
    expect(delivered.filter((cmd) => cmd._id === 'cmd-3')).toHaveLength(1)
  })

  it('durably removes earlier chat deliveries for the stopped session only', async () => {
    const rows = new Map([
      ['send', { _id: 'send', sessionId: 'a', kind: 'sendChatMessage', payload: {} }],
      ['model', { _id: 'model', sessionId: 'a', kind: 'write', payload: { steps: [{}] } }],
      ['resume', { _id: 'resume', sessionId: 'a', kind: 'resumeSession', payload: { images: [{}] } }],
      ['shell', { _id: 'shell', sessionId: 'a', kind: 'write', payload: { data: 'ls\r' } }],
      ['other', { _id: 'other', sessionId: 'b', kind: 'sendChatMessage', payload: {} }],
    ])
    await cancelPendingChatCommands('a', {
      list: async () => [...rows.values()],
      remove: async (id) => { rows.delete(id) },
    })
    expect([...rows.keys()]).toEqual(['shell', 'other'])
  })
})
