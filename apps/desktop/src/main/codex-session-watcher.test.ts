import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, psElapsedSeconds } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  psElapsedSeconds: { value: 0 },
}))

vi.mock('electron', () => ({}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('./idle-notifier', () => ({
  notifyIdleTransition: vi.fn(() => Promise.resolve()),
}))

import { getCodexSessionLogPath } from './codex-hook-runtime'
import { applyCodexHookEvent, initCodexWatcher, markCodexSessionStarted, stopAllCodexWatchers, watchCodexSession } from './codex-session-watcher'
import { notifyIdleTransition } from './idle-notifier'
import { feedTerminalOutput, stopTerminalOutputBuffer } from './terminal-output-buffer'

function writeNativeRollout(
  rootDir: string,
  relativePath: string,
  options: {
    cwd: string
    threadId: string
    sessionStartedAtMs: number
    mtimeMs: number
    lines?: Record<string, unknown>[]
  },
): string {
  const { cwd, threadId, sessionStartedAtMs, mtimeMs, lines = [] } = options
  const filePath = path.join(rootDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(sessionStartedAtMs).toISOString(),
        payload: {
          id: threadId,
          cwd,
          timestamp: new Date(sessionStartedAtMs).toISOString(),
        },
      }),
      ...lines.map((line) => JSON.stringify(line)),
      '',
    ].join('\n'),
  )

  const time = new Date(mtimeMs)
  fs.utimesSync(filePath, time, time)
  return filePath
}

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
    vi.setSystemTime(new Date('2026-03-20T20:00:00.000Z'))
    send.mockReset()
    vi.mocked(notifyIdleTransition).mockClear()
    psElapsedSeconds.value = 0
    execFileMock.mockReset()
    execFileMock.mockImplementation((file: string, _args: string[], optionsOrCallback?: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error: Error | null, stdout: string, stderr: string) => void
        : maybeCallback as (error: Error | null, stdout: string, stderr: string) => void
      if (file === 'ps') {
        callback?.(null, `${psElapsedSeconds.value}\n`, '')
      } else {
        callback?.(new Error(`Unexpected execFile call: ${file}`), '', '')
      }
      return {} as any
    })

    originalHome = process.env.HOME
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-codex-watcher-'))
    process.env.HOME = tempHome

    initCodexWatcher(fakeWindow)
  })

  afterEach(() => {
    stopAllCodexWatchers()
    stopTerminalOutputBuffer()
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

  it('falls back to the native Codex rollout for warm sessions when the hook log is empty', async () => {
    psElapsedSeconds.value = 60

    const logPath = getCodexSessionLogPath(sessionId)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, '')

    const sessionStartedAtMs = Date.now() - 60_000
    const rolloutPath = writeNativeRollout(
      path.join(tempHome, '.codex', 'sessions'),
      path.join('2026', '03', '20', 'rollout-warm.jsonl'),
      {
        cwd: '/repo',
        threadId: 'thread-warm',
        sessionStartedAtMs,
        mtimeMs: sessionStartedAtMs + 1_000,
        lines: [
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: 'ask me something',
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'agent_reasoning',
              text: '**Investigating watcher state**',
            },
          },
        ],
      },
    )

    watchCodexSession(sessionId, '/repo', 999)
    await Promise.resolve()

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'working')

    send.mockClear()

    fs.appendFileSync(rolloutPath, [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Final answer' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'turn_completed',
        },
      }),
      '',
    ].join('\n'))
    const time = new Date(Date.now())
    fs.utimesSync(rolloutPath, time, time)

    await vi.advanceTimersByTimeAsync(1000)

    expect(send).toHaveBeenCalledWith('codex-last-response', sessionId, 'Final answer')
    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'idle')
    expect(notifyIdleTransition).toHaveBeenCalledWith(sessionId, 'codex', 'Final answer', 'ask me something')
  })

  it('uses an explicit launch start to keep Codex working until the rollout turns idle', async () => {
    const logPath = getCodexSessionLogPath(sessionId)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, '')

    markCodexSessionStarted(sessionId)
    watchCodexSession(sessionId, '/repo', 123)

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'working')

    send.mockClear()

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
  })

  it('keeps Codex working while recent terminal output still shows startup activity', async () => {
    const logPath = getCodexSessionLogPath(sessionId)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, '')

    markCodexSessionStarted(sessionId)
    watchCodexSession(sessionId, '/repo', 123)

    send.mockClear()

    feedTerminalOutput(sessionId, 'OpenAI Codex (v0.0.0)\n› Starting MCP servers...\n')

    await vi.advanceTimersByTimeAsync(6000)

    expect(send).not.toHaveBeenCalledWith('codex-work-state', sessionId, 'idle')

    feedTerminalOutput(sessionId, 'OpenAI Codex (v0.0.0)\nAsk me something.\n› \n')

    await vi.advanceTimersByTimeAsync(8000)

    expect(send).toHaveBeenCalledWith('codex-work-state', sessionId, 'idle')
  })
})
