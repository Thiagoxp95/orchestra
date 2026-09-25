import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('./work-state-debug', () => ({
  debugWorkState: vi.fn(),
}))

vi.mock('./agent-session-aliases', () => ({
  registerAgentSessionAlias: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { listLiveSessionStatuses, setChatOwnedCheck, startMonitoring, stopMonitoring } from './process-monitor'
import type { DaemonClient } from './daemon-client'
import type { SessionInfo } from '../daemon/protocol'

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

function mockPsOutput(output: string | Error): void {
  mockedExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      if (output instanceof Error) cb(output, '', '')
      else cb(null, output, '')
    },
  )
}

function fakeClient(sessions: SessionInfo[]): DaemonClient {
  return {
    listSessions: () => Promise.resolve(sessions),
  } as unknown as DaemonClient
}

const SESSION: SessionInfo = {
  sessionId: 's1',
  processSessionId: 's1',
  pid: 1000,
  cwd: '/tmp',
  isAlive: true,
  isSuspended: false,
}

describe('listLiveSessionStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects a claude child process via the parsed ps snapshot', async () => {
    mockPsOutput(
      [
        ' 1000 1 /bin/zsh',
        ' 1001 1000 node /usr/local/bin/claude --some-flag',
      ].join('\n'),
    )

    const result = await listLiveSessionStatuses(fakeClient([SESSION]))

    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('claude')
    expect(result[0].aiPid).toBe(1001)
  })

  it('detects a Cursor agent child process via the parsed ps snapshot', async () => {
    mockPsOutput(
      [
        ' 1000 1 /bin/zsh',
        ' 1001 1000 /usr/local/bin/agent --force --model composer-2-fast',
      ].join('\n'),
    )

    const result = await listLiveSessionStatuses(fakeClient([SESSION]))

    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('cursor')
    expect(result[0].aiPid).toBe(1001)
  })

  it('detects a Cursor agent launched with any flags via its install path', async () => {
    mockPsOutput(
      [
        ' 1000 1 /bin/zsh',
        ' 1001 1000 /Users/me/.local/bin/agent --use-system-ca /Users/me/.local/share/cursor-agent/versions/2026.09.10-fd3934a/index.js --model claude-opus-4-8',
      ].join('\n'),
    )

    const result = await listLiveSessionStatuses(fakeClient([SESSION]))

    expect(result[0].status).toBe('cursor')
    expect(result[0].aiPid).toBe(1001)
  })

  it('throws when ps returns an error instead of mass-flipping sessions to terminal', async () => {
    mockPsOutput(new Error('stdout maxBuffer exceeded'))

    await expect(listLiveSessionStatuses(fakeClient([SESSION]))).rejects.toThrow(
      /snapshotProcessTable unavailable/,
    )
  })

  it('throws when ps returns empty output (no table to parse)', async () => {
    mockPsOutput('   \n  ')

    await expect(listLiveSessionStatuses(fakeClient([SESSION]))).rejects.toThrow(
      /snapshotProcessTable unavailable/,
    )
  })

  it('passes a large maxBuffer to execFile so busy dev Macs do not overflow', async () => {
    mockPsOutput(' 1000 1 /bin/zsh')

    await listLiveSessionStatuses(fakeClient([SESSION]))

    const call = mockedExecFile.mock.calls[0]
    const opts = call[2] as { maxBuffer?: number }
    expect(opts?.maxBuffer).toBeGreaterThanOrEqual(32 * 1024 * 1024)
  })

  it('reports dead sessions as terminal without consulting the process table', async () => {
    mockPsOutput(' 1000 1 /bin/zsh')

    const dead: SessionInfo = { ...SESSION, isAlive: false }
    const result = await listLiveSessionStatuses(fakeClient([dead]))

    expect(result[0].status).toBe('terminal')
    expect(result[0].aiPid).toBeNull()
  })
})

// A chat-owned pane runs its agent over the SDK, so its PTY is a bare shell and
// the poll has nothing worth reporting. What it must NOT do is remember the
// agent it saw before the hand-off: the pane comes back from chat running the
// same CLI, and a remembered 'claude' compares equal to the new one, so nothing
// is announced and the renderer (and the codex rollout watcher, which attaches
// from onStatusChange) never learns the pane has an agent again.
describe('startMonitoring and chat-owned sessions', () => {
  const CLAUDE_PS = [' 1000 1 /bin/zsh', ' 1001 1000 node /usr/local/bin/claude'].join('\n')
  const SHELL_PS = ' 1000 1 /bin/zsh'

  function harness() {
    const sent: unknown[][] = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => { sent.push(args) } },
    } as unknown as Parameters<typeof startMonitoring>[0]
    const client = {
      listSessions: () => Promise.resolve([SESSION]),
      isConnected: () => true,
    } as unknown as DaemonClient
    return { sent, window, client }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stopMonitoring()
    setChatOwnedCheck(() => false)
  })

  it('re-announces the agent after the pane comes back from chat', async () => {
    const { sent, window, client } = harness()
    vi.useFakeTimers()
    try {
      mockPsOutput(CLAUDE_PS)
      startMonitoring(window, client)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sent.map(args => args[2])).toEqual(['claude'])

      // Handed to chat: the CLI is killed, the shell stays, the poll is skipped.
      setChatOwnedCheck(() => true)
      mockPsOutput(SHELL_PS)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sent).toHaveLength(1)

      // Handed back: the same CLI relaunches and must be reported again.
      setChatOwnedCheck(() => false)
      mockPsOutput(CLAUDE_PS)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sent.map(args => args[2])).toEqual(['claude', 'claude'])
    } finally {
      vi.useRealTimers()
      stopMonitoring()
      setChatOwnedCheck(() => false)
    }
  })
})
