import { describe, expect, it } from 'vitest'
import {
  buildWarmAgentPoolKey,
  DEFAULT_WARM_AGENT_POOL_SIZE,
  getWarmAgentKindForCommand,
  isWarmAgentPoolEnabled,
} from './warm-agent-pool'

describe('warm agent pool helpers', () => {
  it('keeps one idle interactive agent per cwd by default', () => {
    expect(DEFAULT_WARM_AGENT_POOL_SIZE).toBe(1)
  })

  it('keeps interactive warm agents behind an explicit experiment flag', () => {
    expect(isWarmAgentPoolEnabled({})).toBe(true)
    expect(isWarmAgentPoolEnabled({ ORCHESTRA_EXPERIMENTAL_WARM_AGENTS: '1' })).toBe(true)
    expect(isWarmAgentPoolEnabled({ ORCHESTRA_EXPERIMENTAL_WARM_AGENTS: '0' })).toBe(false)
  })

  it('builds distinct pool keys per agent kind and cwd', () => {
    expect(buildWarmAgentPoolKey('/repo', 'claude')).toBe('claude:/repo')
    expect(buildWarmAgentPoolKey('/repo', 'codex')).toBe('codex:/repo')
  })

  it('matches only default interactive agent startup commands', () => {
    expect(getWarmAgentKindForCommand('claude --dangerously-skip-permissions')).toBe('claude')
    expect(
      getWarmAgentKindForCommand(
        'codex -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
      )
    ).toBe('codex')
    expect(
      getWarmAgentKindForCommand(
        'ORCHESTRA_CODEX_BIN="$HOME/.orchestra-dev/bin/codex"; [ -x "$ORCHESTRA_CODEX_BIN" ] || ORCHESTRA_CODEX_BIN="$HOME/.orchestra/bin/codex"; "$ORCHESTRA_CODEX_BIN" -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true'
      )
    ).toBe('codex')
    expect(getWarmAgentKindForCommand('claude -p --dangerously-skip-permissions')).toBeNull()
    expect(getWarmAgentKindForCommand('claude --dangerously-skip-permissions \'fix bug\'')).toBeNull()
  })
})
