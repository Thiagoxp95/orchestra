import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

vi.mock('./idle-notifier', () => ({
  notifyIdleTransition: vi.fn(() => Promise.resolve()),
}))

import { getCodexSessionLogPath } from './codex-hook-runtime'
import { applyCodexHookEvent, initCodexWatcher, stopAllCodexWatchers, watchCodexSession } from './codex-session-watcher'
import { notifyIdleTransition } from './idle-notifier'

describe('codex-session-watcher', () => {
  const sessionId = 'session-1'
  const send = vi.fn()
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send,
    },
  } as any

  let originalHome: string | undefined
  let tempHome = ''

  beforeEach(() => {
    vi.useFakeTimers()
    send.mockReset()
    vi.mocked(notifyIdleTransition).mockClear()

    originalHome = process.env.HOME
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-codex-watcher-'))
    process.env.HOME = tempHome

    initCodexWatcher(fakeWindow)
  })

  afterEach(() => {
    stopAllCodexWatchers()
    vi.useRealTimers()
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  it('captures the final response when the log flush lands after the stop hook', async () => {
    const logPath = getCodexSessionLogPath(sessionId)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })

    watchCodexSession(sessionId, '/repo', 123)

    fs.writeFileSync(logPath, `${JSON.stringify({
      kind: 'codex_event',
      payload: { msg: { type: 'task_started' } },
    })}\n`)

    applyCodexHookEvent(sessionId, 'Start')
    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'working')

    send.mockClear()

    applyCodexHookEvent(sessionId, 'Stop')
    expect(send).not.toHaveBeenCalledWith('codex-last-response', sessionId, 'Final answer')

    fs.appendFileSync(logPath, [
      JSON.stringify({
        kind: 'codex_event',
        payload: {
          msg: {
            type: 'raw_response_item',
            item: {
              type: 'message',
              role: 'assistant',
              content: [{ text: 'Final answer' }],
            },
          },
        },
      }),
      JSON.stringify({
        kind: 'codex_event',
        payload: { msg: { type: 'turn_completed' } },
      }),
      '',
    ].join('\n'))

    await vi.advanceTimersByTimeAsync(1000)

    expect(send).toHaveBeenCalledWith('codex-last-response', sessionId, 'Final answer')
    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'idle')
    expect(notifyIdleTransition).toHaveBeenCalledWith(sessionId, 'codex', 'Final answer', undefined)
  })
})
