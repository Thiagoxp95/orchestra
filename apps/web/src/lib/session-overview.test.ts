import { describe, expect, it } from 'vitest'
import {
  buildOverview,
  formatAgo,
  formatTokens,
  groupOverview,
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

function wsItem(sessionId: string, workspaceId: string, status?: RollStatusLike): RollItem {
  return { ...item(sessionId, status), workspaceId, workspaceName: workspaceId.toUpperCase() }
}

const ids = (items: OverviewItem[]): string[] => items.map((i) => i.sessionId)

/** A round wall-clock base, so `min()` below lands on exact bucket boundaries. */
const T0 = 1_785_000_000_000
/** `n` minutes past the base — the granularity the recency sort resolves. */
const min = (n: number): number => T0 + n * 60_000
/** The clock the cards render against; every `min()` below is in its past. */
const NOW = min(120)

describe('buildOverview', () => {
  it('sorts by the agent‑stamped activity, newest first', () => {
    const out = buildOverview(
      [
        item('a', { activeAt: min(1) }),
        item('b', { activeAt: min(3) }),
        item('c', { activeAt: min(2) }),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['b', 'c', 'a'])
  })

  it('floats working sessions above idle ones, however recently the idle ones ran', () => {
    const out = buildOverview(
      [
        item('idle-fresh', { activeAt: min(90) }),
        item('working-old', { work: 'working', activeAt: min(1) }),
        item('idle-old', { activeAt: min(2) }),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['working-old', 'idle-fresh', 'idle-old'])
  })

  it('orders the working group by recency too', () => {
    const out = buildOverview(
      [
        item('w-mid', { work: 'working', activeAt: min(2) }),
        item('w-new', { work: 'working', activeAt: min(3) }),
        item('w-old', { work: 'working', activeAt: min(1) }),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['w-new', 'w-mid', 'w-old'])
  })

  // The regression that made the phone's overview shuffle continuously: every
  // mirror push (a few per second) restamps each working agent's activeAt, so a
  // millisecond-resolution sort re-permuted the whole working group between
  // renders while every card still read "now".
  it('holds sidebar order for agents working within the same displayed minute', () => {
    const order = (offsets: number[]): string[] =>
      ids(
        buildOverview(
          [
            item('a', { work: 'working', activeAt: min(5) + offsets[0] }),
            item('b', { work: 'working', activeAt: min(5) + offsets[1] }),
            item('c', { work: 'working', activeAt: min(5) + offsets[2] }),
          ],
          null,
          NOW,
        ),
      )
    // Three consecutive pushes, each with a different agent printing last.
    expect(order([10, 20, 30])).toEqual(['a', 'b', 'c'])
    expect(order([900, 100, 400])).toEqual(['a', 'b', 'c'])
    expect(order([250, 999, 1])).toEqual(['a', 'b', 'c'])
  })

  // Bucketing on the raw timestamp (floor(activeAt / 60s)) pinned the buckets to
  // wall-clock minute boundaries, so two agents printing 200ms apart still split
  // across one every time the clock rolled over — the list flipped for a moment
  // each minute while both cards plainly read "now". Measuring the age against
  // the same clock the cards render with is what makes them tie.
  it('holds sidebar order across a wall-clock minute boundary', () => {
    const out = buildOverview(
      [
        item('a', { work: 'working', activeAt: min(5) - 100 }),
        item('b', { work: 'working', activeAt: min(5) + 100 }),
      ],
      null,
      min(5) + 500,
    )
    expect(ids(out)).toEqual(['a', 'b'])
  })

  it('still promotes an agent once it is a whole minute fresher', () => {
    const out = buildOverview(
      [
        item('stale', { work: 'working', activeAt: min(5) }),
        item('fresh', { work: 'working', activeAt: min(6) }),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['fresh', 'stale'])
  })

  // The desktop stamps activeAt off its own clock and the phone sorts against
  // its own; a few seconds of skew must not invent a negative age that jumps a
  // session above everything else.
  it('is unmoved by a timestamp from a clock running ahead', () => {
    const out = buildOverview(
      [
        item('a', { work: 'working', activeAt: NOW + 5_000 }),
        item('b', { work: 'working', activeAt: NOW }),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['a', 'b'])
  })

  it('does not float an exited session that is still reported as working', () => {
    const out = buildOverview(
      [item('dead', { work: 'working', exited: true, activeAt: 9_000 }), item('live', { activeAt: 10 })],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['live', 'dead'])
  })

  it('keeps sidebar order for sessions with nothing to sort by, and puts them after', () => {
    const out = buildOverview(
      [item('fresh-agent'), item('ran', { activeAt: min(5) }), item('other-fresh-agent')],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['ran', 'fresh-agent', 'other-fresh-agent'])
  })

  it('sinks an untimed agent to the bottom of the group it is already in', () => {
    const out = buildOverview(
      [
        item('untimed', { work: 'working' }),
        item('timed', { work: 'working', activeAt: min(1) }),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['timed', 'untimed'])
  })

  it('carries every session, shells included, ranked the same way', () => {
    const out = buildOverview(
      [
        item('shell', { work: 'working', activeAt: min(9) }, 'terminal'),
        item('claude', { activeAt: min(1) }, 'claude'),
        item('codex', { activeAt: min(2) }, 'codex'),
        item('other', undefined, 'cursor'),
      ],
      null,
      NOW,
    )
    // A working shell outranks two idle agents; the untimed cursor session sits last.
    expect(ids(out)).toEqual(['shell', 'codex', 'claude', 'other'])
  })

  it('leaves untimed sessions of every kind in sidebar order', () => {
    const out = buildOverview(
      [
        item('shell-a', undefined, 'terminal'),
        item('agent-1'),
        item('shell-b', undefined, 'terminal'),
        item('agent-2'),
      ],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['shell-a', 'agent-1', 'shell-b', 'agent-2'])
  })

  it('sinks exited sessions below live ones however recently they ran', () => {
    const out = buildOverview(
      [item('dead', { exited: true, activeAt: 9_000 }), item('live', { activeAt: 10 }), item('idle')],
      null,
      NOW,
    )
    expect(ids(out)).toEqual(['live', 'idle', 'dead'])
  })

  it('derives the context percentage and rounds it', () => {
    const [card] = buildOverview(
      [item('a', { contextTokens: 98_883, contextWindow: 200_000 })],
      null,
      NOW,
    )
    expect(card.context).toEqual({ usedTokens: 98_883, contextWindow: 200_000, percent: 49 })
  })

  it('clamps a window that has been overrun', () => {
    const [card] = buildOverview(
      [item('a', { contextTokens: 260_000, contextWindow: 200_000 })],
      null,
      NOW,
    )
    expect(card.context?.percent).toBe(100)
  })

  it('has no context for a session missing either half of the pair', () => {
    const out = buildOverview(
      [item('a', { contextTokens: 100 }), item('b', { contextWindow: 200_000 }), item('c')],
      null,
      NOW,
    )
    expect(out.every((c) => c.context === null)).toBe(true)
  })

  it('marks the open session', () => {
    const out = buildOverview([item('a'), item('b')], 'b', NOW)
    expect(out.find((c) => c.sessionId === 'b')?.current).toBe(true)
    expect(out.find((c) => c.sessionId === 'a')?.current).toBe(false)
  })

  it('does not leak its sort scratch fields onto the cards', () => {
    const [card] = buildOverview([item('a', { activeAt: 1 })], null, NOW)
    expect(Object.keys(card)).not.toContain('_rank')
    expect(Object.keys(card)).not.toContain('_index')
  })

  it('is empty for an empty roll', () => {
    expect(buildOverview([], null, NOW)).toEqual([])
  })
})

describe('groupOverview', () => {
  it('sections the sorted cards by workspace, pulling interleaved sessions together', () => {
    const cards = buildOverview(
      [
        wsItem('a1', 'a', { activeAt: min(4) }),
        wsItem('b1', 'b', { activeAt: min(3) }),
        wsItem('a2', 'a', { activeAt: min(1) }),
      ],
      null,
      NOW,
    )
    const groups = groupOverview(cards)
    expect(groups.map((g) => g.workspaceId)).toEqual(['a', 'b'])
    expect(groups.map((g) => ids(g.items))).toEqual([['a1', 'a2'], ['b1']])
  })

  it('places a workspace where its best card sorted — a working agent floats its group', () => {
    const cards = buildOverview(
      [
        wsItem('a1', 'a', { activeAt: min(90) }),
        wsItem('b1', 'b', { work: 'working', activeAt: min(1) }),
      ],
      null,
      NOW,
    )
    expect(groupOverview(cards).map((g) => g.workspaceId)).toEqual(['b', 'a'])
  })

  it('carries the workspace identity onto the group', () => {
    const cards = buildOverview(
      [{ ...wsItem('a1', 'a'), workspaceEmoji: '🎶' }],
      null,
      NOW,
    )
    const [group] = groupOverview(cards)
    expect(group.workspaceName).toBe('A')
    expect(group.workspaceEmoji).toBe('🎶')
  })

  it('keeps the in-group order sorted: working first, exited last', () => {
    const cards = buildOverview(
      [
        wsItem('dead', 'a', { exited: true, activeAt: min(100) }),
        wsItem('busy', 'a', { work: 'working', activeAt: min(1) }),
        wsItem('idle', 'a', { activeAt: min(50) }),
      ],
      null,
      NOW,
    )
    expect(groupOverview(cards).map((g) => ids(g.items))).toEqual([['busy', 'idle', 'dead']])
  })

  it('is empty for no cards', () => {
    expect(groupOverview([])).toEqual([])
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
