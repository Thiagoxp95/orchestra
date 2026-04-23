// apps/desktop/src/main/last-user-message-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setLastUserMessage,
  getLastUserMessage,
  clearSession,
  subscribe,
  __resetForTests,
} from './last-user-message-store'

describe('last-user-message-store', () => {
  beforeEach(() => __resetForTests())

  it('stores and retrieves the message', () => {
    setLastUserMessage('s1', 'hello')
    expect(getLastUserMessage('s1')?.text).toBe('hello')
  })

  it('notifies subscribers on change', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', 'hello')
    expect(handler).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello', timestamp: expect.any(Number) })
  })

  it('does not re-broadcast when text is unchanged', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', 'hello')
    setLastUserMessage('s1', 'hello')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('broadcasts when text changes', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', 'a')
    setLastUserMessage('s1', 'b')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('clearSession removes entry', () => {
    setLastUserMessage('s1', 'hello')
    clearSession('s1')
    expect(getLastUserMessage('s1')).toBeUndefined()
  })

  it('ignores empty/null text', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', '')
    expect(handler).not.toHaveBeenCalled()
  })
})
