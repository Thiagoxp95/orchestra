import { describe, expect, it } from 'vitest'
import {
  classifyTwoFinger,
  drawerCommit,
  DRAWER_OPEN_PX,
  flattenRoll,
  rollCommit,
  rollIndex,
  rollNeighbor,
  ROLL_AXIS_LOCK_PX,
  type RollItem,
  type RollSessionLike,
  type RollWorkspaceLike,
} from './session-roll'

const workspaces: RollWorkspaceLike[] = [
  {
    id: 'wsA',
    name: 'Orchestra',
    color: '#2b6cb0',
    emoji: '🎻',
    trees: [
      { rootDir: '/code/orchestra', branch: 'main', displayName: 'Orchestra', sessionIds: ['a1'] },
      { rootDir: '/code/orchestra-feat', branch: 'feat/roll', sessionIds: ['a2', 'a3'] },
    ],
  },
  {
    id: 'wsB',
    name: 'Tedy',
    trees: [{ rootDir: '/code/tedy', sessionIds: ['b1'] }],
  },
]

const sessions: Record<string, RollSessionLike> = {
  a1: { label: 'claude', processStatus: 'claude', workspaceId: 'wsA' },
  a2: { label: 'codex', processStatus: 'codex', workspaceId: 'wsA' },
  a3: { label: 'shell', processStatus: 'idle', workspaceId: 'wsA' },
  b1: { label: 'claude', processStatus: 'claude', workspaceId: 'wsB' },
}

const roll = () => flattenRoll(workspaces, sessions, { a2: { label: 'refactoring the bridge', work: 'working' } })

const ids = (items: RollItem[]) => items.map((i) => i.sessionId)

describe('flattenRoll', () => {
  it('runs workspace → worktree → session, the order the sidebar draws', () => {
    expect(ids(roll())).toEqual(['a1', 'a2', 'a3', 'b1'])
  })

  it('carries the workspace identity onto every card', () => {
    const [first] = roll()
    expect(first).toMatchObject({
      workspaceId: 'wsA',
      workspaceName: 'Orchestra',
      workspaceEmoji: '🎻',
      color: '#2b6cb0',
      worktree: 'main',
    })
  })

  it('prefers the live status label over the session label', () => {
    expect(roll()[1].label).toBe('refactoring the bridge')
    expect(roll()[2].label).toBe('shell')
  })

  it('labels the base tree by branch and worktrees by branch too', () => {
    expect(roll()[0].worktree).toBe('main')
    expect(roll()[1].worktree).toBe('feat/roll')
  })

  it('falls back to the folder name when a tree has no branch', () => {
    expect(roll()[3].worktree).toBe('tedy')
  })

  it('skips sessions the mirror has not described yet', () => {
    const partial = { a1: sessions.a1 }
    expect(ids(flattenRoll(workspaces, partial, {}))).toEqual(['a1'])
  })

  it('gives a session listed under two trees exactly one slot', () => {
    const dupe: RollWorkspaceLike[] = [
      {
        id: 'wsA',
        name: 'Orchestra',
        trees: [
          { rootDir: '/code/orchestra', sessionIds: ['a1'] },
          { rootDir: '/code/orchestra-feat', sessionIds: ['a1', 'a2'] },
        ],
      },
    ]
    expect(ids(flattenRoll(dupe, sessions, {}))).toEqual(['a1', 'a2'])
  })
})

describe('rollNeighbor', () => {
  it('steps down and up the flattened list, across workspaces', () => {
    expect(rollNeighbor(roll(), 'a3', 1)?.sessionId).toBe('b1')
    expect(rollNeighbor(roll(), 'b1', -1)?.sessionId).toBe('a3')
  })

  it('wraps at both ends so the roll never dead-ends', () => {
    expect(rollNeighbor(roll(), 'b1', 1)?.sessionId).toBe('a1')
    expect(rollNeighbor(roll(), 'a1', -1)?.sessionId).toBe('b1')
  })

  it('opens the first (or last) session when nothing is attached yet', () => {
    expect(rollNeighbor(roll(), null, 1)?.sessionId).toBe('a1')
    expect(rollNeighbor(roll(), null, -1)?.sessionId).toBe('b1')
  })

  it('treats a session that has since died like nothing being attached', () => {
    expect(rollNeighbor(roll(), 'gone', 1)?.sessionId).toBe('a1')
  })

  it('has nowhere to go with one session, or none', () => {
    expect(rollNeighbor(roll().slice(0, 1), 'a1', 1)).toBeNull()
    expect(rollNeighbor([], null, 1)).toBeNull()
  })
})

describe('rollIndex', () => {
  it('reports the position, and -1 for nothing attached', () => {
    expect(rollIndex(roll(), 'a3')).toBe(2)
    expect(rollIndex(roll(), null)).toBe(-1)
    expect(rollIndex(roll(), 'gone')).toBe(-1)
  })
})

describe('classifyTwoFinger', () => {
  it('waits until the gesture has moved far enough to read', () => {
    expect(classifyTwoFinger(2, 6, 1)).toBe('pending')
    expect(classifyTwoFinger(0, ROLL_AXIS_LOCK_PX - 1, 0)).toBe('pending')
  })

  it('takes fingers travelling together vertically', () => {
    expect(classifyTwoFinger(3, -40, 2)).toBe('roll')
    expect(classifyTwoFinger(0, 30, 0)).toBe('roll')
  })

  it('leaves a pinch alone', () => {
    expect(classifyTwoFinger(0, 10, 60)).toBe('reject')
    expect(classifyTwoFinger(0, -10, -60)).toBe('reject')
  })

  it('takes fingers travelling together rightward as a drawer pull', () => {
    expect(classifyTwoFinger(50, 8, 0)).toBe('drawer')
    // Fingers drifting a little apart mid-swipe is a swipe, not a pinch: the spread
    // has to beat both axes, or every real drawer pull would read as a pinch.
    expect(classifyTwoFinger(50, 2, 6)).toBe('drawer')
  })

  it('leaves a leftward pan alone — the drawer is already closed', () => {
    expect(classifyTwoFinger(-50, 8, 0)).toBe('reject')
  })
})

describe('drawerCommit', () => {
  it('opens once the pull has covered the distance', () => {
    expect(drawerCommit(DRAWER_OPEN_PX - 1, 500)).toBe(false)
    expect(drawerCommit(DRAWER_OPEN_PX, 500)).toBe(true)
  })

  it('opens on a fast flick that has not got there yet', () => {
    expect(drawerCommit(30, 50)).toBe(true)
  })

  it('does not let a jittery two-finger tap open it', () => {
    expect(drawerCommit(8, 10)).toBe(false)
    expect(drawerCommit(0, 0)).toBe(false)
  })

  it('ignores a leftward drag outright', () => {
    expect(drawerCommit(-200, 100)).toBe(false)
  })
})

describe('rollCommit', () => {
  const H = 700 // ~a phone's terminal area

  it('snaps back a drag that never committed', () => {
    expect(rollCommit(-30, H, 500)).toBe(0)
    expect(rollCommit(40, H, 900)).toBe(0)
  })

  it('commits a drag past the distance threshold', () => {
    expect(rollCommit(-120, H, 600)).toBe(1)
    expect(rollCommit(120, H, 600)).toBe(-1)
  })

  it('commits a fast flick that barely moved', () => {
    expect(rollCommit(-30, H, 50)).toBe(1)
    expect(rollCommit(30, H, 50)).toBe(-1)
  })

  it('does not let a jittery two-finger tap flick the roll', () => {
    expect(rollCommit(-8, H, 10)).toBe(0)
  })

  it('keeps the distance threshold honest on a short viewport', () => {
    // 15% of 200px is under the floor — the floor wins.
    expect(rollCommit(-35, 200, 800)).toBe(0)
    expect(rollCommit(-50, 200, 800)).toBe(1)
  })

  it('survives a zero-length gesture without dividing by zero', () => {
    expect(rollCommit(0, H, 0)).toBe(0)
  })
})
