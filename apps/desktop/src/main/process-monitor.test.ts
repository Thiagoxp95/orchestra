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
import { listLiveSessionStatuses } from './process-monitor'
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
