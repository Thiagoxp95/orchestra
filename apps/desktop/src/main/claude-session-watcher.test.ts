import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { tempHome, execFileMock } = vi.hoisted(() => ({
  tempHome: `${(process.env.TMPDIR ?? '/tmp').replace(/\/?$/, '/')}orchestra-claude-watcher-${Math.random().toString(36).slice(2)}`,
  execFileMock: vi.fn(),
}))

const originalHome = process.env.HOME
process.env.HOME = tempHome

vi.mock('electron', () => ({}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('./idle-notifier', () => ({
  notifyIdleTransition: vi.fn(() => Promise.resolve()),
}))

vi.mock('./work-state-debug', () => ({
  debugWorkState: vi.fn(),
}))

import { PromptHistoryWriter } from '../daemon/prompt-history-writer'
import { feedTerminalOutput, stopTerminalOutputBuffer } from './terminal-output-buffer'
import {
  initClaudeWatcher,
  markClaudeSessionStarted,
  observeTerminalData,
  stopAllWatchers,
  watchSession,
} from './claude-session-watcher'
import { notifyIdleTransition } from './idle-notifier'

describe('claude-session-watcher', () => {
  const send = vi.fn()
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send,
    },
  } as any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-20T20:00:00.000Z'))
    send.mockReset()
    execFileMock.mockReset()
    vi.mocked(notifyIdleTransition).mockClear()

    fs.rmSync(tempHome, { recursive: true, force: true })
    fs.mkdirSync(tempHome, { recursive: true })

    initClaudeWatcher(fakeWindow)
  })

  afterEach(() => {
    stopAllWatchers()
    stopTerminalOutputBuffer()
    vi.useRealTimers()
  })

  it('recovers to idle when a stale working title blocks a prompt-guided binding', async () => {
    const sessionId = 'session-1'
    const siblingSessionId = 'session-2'
    const cwd = '/repo'
    const projectDir = path.join(tempHome, '.claude', 'projects', '-repo')
    fs.mkdirSync(projectDir, { recursive: true })

    const promptWriter = new PromptHistoryWriter(sessionId)
    promptWriter.open()
    promptWriter.feedUserInput('ask me something\r')
    promptWriter.close()

    watchSession(sessionId, cwd)
    watchSession(siblingSessionId, cwd)
    markClaudeSessionStarted(sessionId)
    observeTerminalData(sessionId, '\u001b]0;⠂ Claude Code\u0007')

    send.mockClear()

    const jsonlPath = path.join(projectDir, 'session.jsonl')
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: 'user',
          message: { content: 'ask me something' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done' }],
          },
        }),
        '',
      ].join('\n'),
    )

    feedTerminalOutput(sessionId, '\n> \nshift+tab to cycle\nbypass permissions on\n')

    await vi.advanceTimersByTimeAsync(2500)

    expect(send).not.toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')

    send.mockClear()

    await vi.advanceTimersByTimeAsync(2500)

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')

    await vi.advanceTimersByTimeAsync(1000)

    expect(notifyIdleTransition).toHaveBeenCalledWith(sessionId, 'claude', 'Done', 'ask me something')
  })

  it('keeps Claude working while recent terminal activity still shows active thinking', async () => {
    const sessionId = 'session-pondering'
    const cwd = '/repo'

    watchSession(sessionId, cwd)
    markClaudeSessionStarted(sessionId)
    observeTerminalData(sessionId, '\u001b]0;⠂ Claude Code\u0007')

    send.mockClear()

    feedTerminalOutput(sessionId, '\n> \nshift+tab to cycle\n✢ Pondering…\n')

    await vi.advanceTimersByTimeAsync(6000)

    expect(send).not.toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')

    await vi.advanceTimersByTimeAsync(8000)

    expect(send).toHaveBeenCalledWith('claude-work-state', sessionId, 'idle')
  })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  fs.rmSync(tempHome, { recursive: true, force: true })
})
