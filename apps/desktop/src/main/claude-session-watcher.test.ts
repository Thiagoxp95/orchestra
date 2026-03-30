import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}))

vi.mock('./terminal-output-buffer', () => ({
  getLastMeaningfulText: vi.fn(() => ''),
  getTerminalBufferText: vi.fn(() => ''),
  hasRecentTerminalOutput: vi.fn(() => false),
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
import { getTerminalBufferText, hasRecentTerminalOutput } from './terminal-output-buffer'

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

  it('detects idle via terminal fallback when permission dialog shows "Tab to amend"', () => {
    const sessionId = 'perm-dialog-1'

    // Simulate a permission dialog in the terminal buffer
    vi.mocked(getTerminalBufferText).mockReturnValue(
      '● Edit file\n../../../.claude/skills/auto-triage/SKILL.md\n\n' +
      '[diff content here]\n\n' +
      'Do you want to make this edit to SKILL.md?\n' +
      '  ❯ 1. Yes\n' +
      '  2. Yes, and allow Claude to edit its own settings for this session\n' +
      '  3. No\n\n' +
      'Esc to cancel · Tab to amend\n'
    )

    watchSession(sessionId, '/repo')
    markClaudeSessionStarted(sessionId)
    send.mockClear()

    // Advance past IDLE_FALLBACK_DELAY_MS (5s) + poll interval (500ms)
    vi.advanceTimersByTime(5500)

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')
  })

  it('does not re-enter working from a stale spinner outside the active terminal tail', () => {
    const sessionId = 'stale-spinner-1'

    vi.mocked(hasRecentTerminalOutput).mockReturnValue(true)
    vi.mocked(getTerminalBufferText).mockReturnValue(
      [
        '⏵⏵ bypass permissions on (shift+tab to cycle)',
        '',
        'Old redraw fragment',
        '✳',
        'x'.repeat(220),
      ].join('\n')
    )

    watchSession(sessionId, '/repo')
    send.mockClear()

    vi.advanceTimersByTime(600)

    expect(send).not.toHaveBeenCalledWith('claude-work-state', sessionId, 'working')
  })

  it('re-enters working when a Claude streaming verb is visible near the bottom', () => {
    const sessionId = 'streaming-verb-1'

    vi.mocked(hasRecentTerminalOutput).mockReturnValue(true)
    vi.mocked(getTerminalBufferText).mockReturnValue(
      [
        '⏵⏵ bypass permissions on (shift+tab to cycle)',
        'Searching for 1 pattern…',
        'Scurrying… (34s · ↑ 483 tokens)',
        '/',
      ].join('\n')
    )

    watchSession(sessionId, '/repo')
    send.mockClear()

    vi.advanceTimersByTime(600)

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'working')
  })
})
