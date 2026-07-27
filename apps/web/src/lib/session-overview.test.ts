import { describe, expect, it } from 'vitest'
import {
  buildOverview,
  formatAgo,
  formatTokens,
  isAgentSession,
  type OverviewItem,
} from './session-overview'
import type { RollItem, RollStatusLike } from './session-roll'

function item(sessionId: string, status?: RollStatusLike, processStatus = 'claude'): RollItem {
  return {
    sessionId,
    label: sessionId,
    processStatus,
    workspaceId: 'ws',
    workspaceName: 'Workspace',
    worktree: 'main',
    status,
  }
}

const ids = (items: OverviewItem[]): string[] => items.map((i) => i.sessionId)

describe('buildOverview', () => {
  it('sorts by the agent‑stamped activity, newest first', () => {
    const out = buildOverview(
      [
        item('a', { activeAt: 100 }),
        item('b', { activeAt: 300 }),
        item('c', { activeAt: 200 }),
      ],
      null,
    )
    expect(ids(out)).toEqual(['b', 'c', 'a'])
  })

  it('floats working sessions above idle ones, however recently the idle ones ran', () => {
    const out = buildOverview(
      [
        item('idle-fresh', { activeAt: 9_000 }),
        item('working-old', { work: 'working', activeAt: 10 }),
        item('idle-old', { activeAt: 20 }),
      ],
      null,
    )
    expect(ids(out)).toEqual(['working-old', 'idle-fresh', 'idle-old'])
  })

  it('orders the working group by recency too', () => {
    const out = buildOverview(
      [
        item('w-mid', { work: 'working', activeAt: 200 }),
        item('w-new', { work: 'working', activeAt: 300 }),
        item('w-old', { work: 'working', activeAt: 100 }),
      ],
      null,
    )
    expect(ids(out)).toEqual(['w-new', 'w-mid', 'w-old'])
  })

  it('does not float an exited session that is still reported as working', () => {
    const out = buildOverview(
      [item('dead', { work: 'working', exited: true, activeAt: 9_000 }), item('live', { activeAt: 10 })],
      null,
    )
    expect(ids(out)).toEqual(['live', 'dead'])
  })

  it('keeps sidebar order for sessions with nothing to sort by, and puts them after', () => {
    const out = buildOverview(
      [item('shell1', undefined, 'terminal'), item('agent', { activeAt: 500 }), item('shell2', undefined, 'terminal')],
      null,
    )
    expect(ids(out)).toEqual(['agent', 'shell1', 'shell2'])
  })

  it('sinks exited sessions below live ones however recently they ran', () => {
    const out = buildOverview(
      [item('dead', { exited: true, activeAt: 9_000 }), item('live', { activeAt: 10 }), item('idle')],
      null,
    )
    expect(ids(out)).toEqual(['live', 'idle', 'dead'])
  })

  it('derives the context percentage and rounds it', () => {
    const [card] = buildOverview([item('a', { contextTokens: 98_883, contextWindow: 200_000 })], null)
    expect(card.context).toEqual({ usedTokens: 98_883, contextWindow: 200_000, percent: 49 })
  })

  it('clamps a window that has been overrun', () => {
    const [card] = buildOverview([item('a', { contextTokens: 260_000, contextWindow: 200_000 })], null)
    expect(card.context?.percent).toBe(100)
  })

  it('has no context for a session missing either half of the pair', () => {
    const out = buildOverview(
      [item('a', { contextTokens: 100 }), item('b', { contextWindow: 200_000 }), item('c')],
      null,
    )
    expect(out.every((c) => c.context === null)).toBe(true)
  })

  it('marks the open session', () => {
    const out = buildOverview([item('a'), item('b')], 'b')
    expect(out.find((c) => c.sessionId === 'b')?.current).toBe(true)
    expect(out.find((c) => c.sessionId === 'a')?.current).toBe(false)
  })

  it('does not leak its sort scratch fields onto the cards', () => {
    const [card] = buildOverview([item('a', { activeAt: 1 })], null)
    expect(Object.keys(card)).not.toContain('_rank')
    expect(Object.keys(card)).not.toContain('_index')
  })

  it('is empty for an empty roll', () => {
    expect(buildOverview([], null)).toEqual([])
  })
})

describe('isAgentSession', () => {
  it('is true only for the two agents', () => {
    expect(isAgentSession('claude')).toBe(true)
    expect(isAgentSession('codex')).toBe(true)
    expect(isAgentSession('terminal')).toBe(false)
    expect(isAgentSession('cursor')).toBe(false)
  })
})

describe('formatTokens', () => {
  it('leaves counts under a thousand alone', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
  })

  it('abbreviates thousands, dropping a trailing zero decimal', () => {
    expect(formatTokens(1_200)).toBe('1.2k')
    expect(formatTokens(98_883)).toBe('98.9k')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(2_000)).toBe('2k')
  })

  it('abbreviates millions', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(1_000_000)).toBe('1M')
  })

  it('is safe on nonsense', () => {
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
  })
})

describe('formatAgo', () => {
  const now = 1_000_000_000

  it('collapses anything under a minute to "now"', () => {
    expect(formatAgo(now, now)).toBe('now')
    expect(formatAgo(now - 59_000, now)).toBe('now')
  })

  it('steps up through minutes, hours and days', () => {
    expect(formatAgo(now - 4 * 60_000, now)).toBe('4m')
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2h')
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('3d')
  })

  it('has nothing to say without a timestamp', () => {
    expect(formatAgo(null, now)).toBeNull()
  })

  it('never reads as the future when a clock is skewed', () => {
    expect(formatAgo(now + 60_000, now)).toBe('now')
  })
})
