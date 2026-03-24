import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}))

vi.mock('./terminal-output-buffer', () => ({
  getLastMeaningfulText: vi.fn(() => ''),
  getTerminalBufferText: vi.fn(() => ''),
}))

vi.mock('./idle-notifier', () => ({
  notifyIdleTransition: vi.fn(() => Promise.resolve()),
}))

vi.mock('./work-state-debug', () => ({
  debugWorkState: vi.fn(),
}))

import {
  applyClaudeHookEvent,
  initClaudeWatcher,
  markClaudeSessionStarted,
  stopAllWatchers,
  watchSession,
} from './claude-session-watcher'
import { notifyIdleTransition } from './idle-notifier'

describe('claude-session-watcher (hook-based)', () => {
  const send = vi.fn()
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send },
  } as any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-20T20:00:00.000Z'))
    send.mockReset()
    vi.mocked(notifyIdleTransition).mockClear()
    initClaudeWatcher(fakeWindow)
  })

  afterEach(() => {
    stopAllWatchers()
    vi.useRealTimers()
  })

  it('emits working when markClaudeSessionStarted is called', () => {
    const sessionId = 'session-1'
    watchSession(sessionId, '/repo')
    markClaudeSessionStarted(sessionId)

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'working')
  })

  it('emits idle on Stop hook event', () => {
    const sessionId = 'session-1'
    watchSession(sessionId, '/repo')
    markClaudeSessionStarted(sessionId)
    send.mockClear()

    applyClaudeHookEvent(sessionId, 'Stop')

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')
  })

  it('emits working on Start hook event', () => {
    const sessionId = 'session-1'
    watchSession(sessionId, '/repo')

    applyClaudeHookEvent(sessionId, 'Start')

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'working')
  })

  it('triggers idle notification after Stop hook', async () => {
    const sessionId = 'session-1'
    watchSession(sessionId, '/repo')
    markClaudeSessionStarted(sessionId)
    applyClaudeHookEvent(sessionId, 'Stop')

    await vi.advanceTimersByTimeAsync(1000)

    expect(notifyIdleTransition).toHaveBeenCalledWith(sessionId, 'claude', undefined, undefined)
  })

  it('applies pending hook events when watch starts after hook fires', () => {
    const sessionId = 'session-1'

    // Hook fires before watchSession
    applyClaudeHookEvent(sessionId, 'Start')

    // Now watch — should apply the pending Start
    watchSession(sessionId, '/repo')

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'working')
  })

  it('handles PermissionRequest hook event', () => {
    const sessionId = 'session-1'
    watchSession(sessionId, '/repo')
    markClaudeSessionStarted(sessionId)
    send.mockClear()

    applyClaudeHookEvent(sessionId, 'PermissionRequest')

    // Legacy path emits idle for PermissionRequest
    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')
  })
})
