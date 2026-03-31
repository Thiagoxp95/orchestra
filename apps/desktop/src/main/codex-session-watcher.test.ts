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
  applyCodexHookEvent,
  initCodexWatcher,
  markCodexSessionStarted,
  stopAllCodexWatchers,
  watchCodexSession,
} from './codex-session-watcher'
import { notifyIdleTransition } from './idle-notifier'

describe('codex-session-watcher (hook-based)', () => {
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
    initCodexWatcher(fakeWindow)
  })

  afterEach(() => {
    stopAllCodexWatchers()
    vi.useRealTimers()
  })

  it('emits working when markCodexSessionStarted is called', () => {
    const sessionId = 'session-1'
    watchCodexSession(sessionId, '/repo')
    markCodexSessionStarted(sessionId)

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'working')
  })

  it('emits idle on Stop hook event', () => {
    const sessionId = 'session-1'
    watchCodexSession(sessionId, '/repo')
    markCodexSessionStarted(sessionId)
    send.mockClear()

    applyCodexHookEvent(sessionId, 'Stop')

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'idle')
  })

  it('emits waitingApproval on PermissionRequest hook', () => {
    const sessionId = 'session-1'
    watchCodexSession(sessionId, '/repo')
    markCodexSessionStarted(sessionId)
    send.mockClear()

    applyCodexHookEvent(sessionId, 'PermissionRequest')

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'waitingApproval')
  })

  it('emits waitingUserInput on UserInputRequest hook', () => {
    const sessionId = 'session-1'
    watchCodexSession(sessionId, '/repo')
    markCodexSessionStarted(sessionId)
    send.mockClear()

    applyCodexHookEvent(sessionId, 'UserInputRequest')

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'waitingUserInput')
  })

  it('triggers idle notification after Stop hook', async () => {
    const sessionId = 'session-1'
    watchCodexSession(sessionId, '/repo')
    markCodexSessionStarted(sessionId)
    applyCodexHookEvent(sessionId, 'Stop')

    await vi.advanceTimersByTimeAsync(3000)

    expect(notifyIdleTransition).toHaveBeenCalledWith(sessionId, 'codex', undefined, undefined)
  })

  it('applies pending hook events when watch starts after hook fires', () => {
    const sessionId = 'session-1'

    applyCodexHookEvent(sessionId, 'Start')
    watchCodexSession(sessionId, '/repo')

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'working')
  })
})
