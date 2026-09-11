import { describe, expect, it } from 'vitest'
import { RemoteChatInterrupts } from './remote-chat-interrupts'

const send = (id: string, sessionId = 'a') => ({ _id: id, sessionId, kind: 'sendChatMessage', payload: { text: id } })
const stop = (id: string, sessionId = 'a') => ({ _id: id, sessionId, kind: 'write', payload: { data: '\x1b', interruptChat: true } })

describe('RemoteChatInterrupts', () => {
  it('handles Stop on arrival, cancels earlier chat commands, and preserves later sends', () => {
    const seen: string[] = []
    const interrupts = new RemoteChatInterrupts((sessionId) => { seen.push(sessionId) })
    const batch = [send('first'), send('other', 'b'), stop('stop'), send('next')]
    interrupts.observe(batch)
    expect(seen).toEqual(['a'])
    expect(batch.filter((cmd) => interrupts.shouldApply(cmd)).map((cmd) => cmd._id)).toEqual(['other', 'next'])
    interrupts.observe(batch)
    expect(seen).toEqual(['a'])
  })

  it('preserves raw terminal writes but cancels queued model and question controls', () => {
    const interrupts = new RemoteChatInterrupts(() => {})
    const terminal = { _id: 'raw', sessionId: 'a', kind: 'write', payload: { data: 'ls\r' } }
    const model = { _id: 'model', sessionId: 'a', kind: 'write', payload: { steps: [{}] } }
    interrupts.observe([terminal, model, stop('stop')])
    expect(interrupts.shouldApply(terminal)).toBe(true)
    expect(interrupts.shouldApply(model)).toBe(false)
  })

  it('reports interrupt failures and never replays a late Escape into a newer turn', () => {
    const errors: unknown[] = []
    const interrupts = new RemoteChatInterrupts(() => { throw new Error('disconnected') }, (error) => errors.push(error))
    const command = stop('stop')
    expect(() => interrupts.observe([command])).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(interrupts.shouldApply(command)).toBe(false)
  })

  it('cancels queued image-only resume deliveries', () => {
    const interrupts = new RemoteChatInterrupts(() => {})
    const resume = { _id: 'resume', sessionId: 'a', kind: 'resumeSession', payload: { images: [{ storageId: 'image' }] } }
    interrupts.observe([resume, stop('stop')])
    expect(interrupts.shouldApply(resume)).toBe(false)
  })

  it('invalidates older snapshot commands even if Stop arrives on a separate priority page', () => {
    const interrupts = new RemoteChatInterrupts(() => {})
    const old = { ...send('old'), _creationTime: 10 }
    const next = { ...send('next'), _creationTime: 30 }
    interrupts.observe([{ ...stop('stop'), _creationTime: 20 }])
    interrupts.observe([next])
    expect(interrupts.shouldApply(old)).toBe(false)
    expect(interrupts.shouldApply(next)).toBe(true)
  })
})
