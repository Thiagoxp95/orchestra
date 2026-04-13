import { describe, expect, it } from 'vitest'
import {
  buildWarmAgentPoolKey,
  DEFAULT_WARM_AGENT_POOL_SIZE,
  getWarmAgentKindForCommand,
  isWarmAgentPoolEnabled,
  WARM_AGENT_IDLE_TTL_MS,
} from './warm-agent-pool'

describe('warm agent pool helpers', () => {
  it('keeps one idle interactive agent per cwd by default', () => {
    expect(DEFAULT_WARM_AGENT_POOL_SIZE).toBe(1)
    expect(WARM_AGENT_IDLE_TTL_MS).toBe(2 * 60_000)
  })

  it('keeps interactive warm agents behind an explicit experiment flag', () => {
    expect(isWarmAgentPoolEnabled({})).toBe(false)
    expect(isWarmAgentPoolEnabled({ ORCHESTRA_EXPERIMENTAL_WARM_AGENTS: '1' })).toBe(true)
    expect(isWarmAgentPoolEnabled({ ORCHESTRA_EXPERIMENTAL_WARM_AGENTS: '0' })).toBe(false)
  })

  it('builds pool keys for Claude interactive agents', () => {
    expect(buildWarmAgentPoolKey('/repo', 'claude')).toBe('claude:/repo')
  })

  it('matches only default interactive Claude startup commands', () => {
    expect(getWarmAgentKindForCommand('claude --dangerously-skip-permissions')).toBe('claude')
    expect(getWarmAgentKindForCommand('codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox')).toBeNull()
    expect(getWarmAgentKindForCommand('claude -p --dangerously-skip-permissions')).toBeNull()
    expect(getWarmAgentKindForCommand('claude --dangerously-skip-permissions \'fix bug\'')).toBeNull()
  })
})
