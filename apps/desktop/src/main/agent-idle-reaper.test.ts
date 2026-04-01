import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_IDLE_REAPER_ENABLE_ENV_VAR,
  AgentIdleReaper,
  isAgentIdleReaperEnabled,
} from './agent-idle-reaper'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

function buildStatus(
  overrides: Partial<NormalizedAgentSessionStatus> = {},
): NormalizedAgentSessionStatus {
  return {
    sessionId: 'session-1',
    agent: 'claude',
    state: 'idle',
    authority: 'claude-hooks',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('AgentIdleReaper', () => {
  const suspend = vi.fn(() => Promise.resolve())
  const window = {
    isFocused: vi.fn(() => false),
    on: vi.fn(),
  } as any

  beforeEach(() => {
    vi.useFakeTimers()
    suspend.mockClear()
    window.isFocused.mockReset()
    window.isFocused.mockReturnValue(false)
    window.on.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('suspends an idle session after the configured timeout', async () => {
    const reaper = new AgentIdleReaper({ client: { suspend }, idleTimeoutMs: 1_000 })
    reaper.init(window)
    reaper.updateStatus(buildStatus())

    await vi.advanceTimersByTimeAsync(1_000)

    expect(suspend).toHaveBeenCalledWith('session-1')
  })

  it('cancels suspension when the session becomes active again', async () => {
    const reaper = new AgentIdleReaper({ client: { suspend }, idleTimeoutMs: 1_000 })
    reaper.init(window)
    reaper.updateStatus(buildStatus())
    reaper.updateStatus(buildStatus({ state: 'working' }))

    await vi.advanceTimersByTimeAsync(1_000)

    expect(suspend).not.toHaveBeenCalled()
  })

  it('protects the focused active session and retries later', async () => {
    window.isFocused.mockReturnValue(true)
    const reaper = new AgentIdleReaper({
      client: { suspend },
      idleTimeoutMs: 1_000,
      activeSessionRecheckMs: 200,
    })
    reaper.init(window)
    reaper.setActiveSessionId('session-1')
    reaper.updateStatus(buildStatus())

    await vi.advanceTimersByTimeAsync(1_000)
    expect(suspend).not.toHaveBeenCalled()

    window.isFocused.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(suspend).toHaveBeenCalledWith('session-1')
  })

  it('resets the idle timer when activity is recorded', async () => {
    const reaper = new AgentIdleReaper({ client: { suspend }, idleTimeoutMs: 1_000 })
    reaper.init(window)
    reaper.updateStatus(buildStatus())

    await vi.advanceTimersByTimeAsync(900)
    reaper.noteActivity('session-1')
    await vi.advanceTimersByTimeAsync(900)
    expect(suspend).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(suspend).toHaveBeenCalledWith('session-1')
  })
})

describe('isAgentIdleReaperEnabled', () => {
  it('is disabled by default', () => {
    expect(isAgentIdleReaperEnabled({})).toBe(false)
  })

  it('accepts explicit truthy env values', () => {
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: '1' })).toBe(true)
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: 'true' })).toBe(true)
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: 'yes' })).toBe(true)
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: 'on' })).toBe(true)
  })

  it('rejects falsy or unknown env values', () => {
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: '0' })).toBe(false)
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: 'false' })).toBe(false)
    expect(isAgentIdleReaperEnabled({ [AGENT_IDLE_REAPER_ENABLE_ENV_VAR]: 'no' })).toBe(false)
  })
})
