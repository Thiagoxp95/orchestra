import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFile }))

import { getPullRequest, getCachedPullRequest, setPullRequestChangeListener } from './pr-mirror'

/** Answer the next `gh pr view` with this JSON (or an error, when null). */
function ghReturns(json: object | null) {
  execFile.mockImplementationOnce((_shell, _args, _opts, cb: (e: Error | null, out: string) => void) => {
    if (!json) cb(new Error('no pull requests found'), '')
    else cb(null, JSON.stringify(json))
  })
}

const OPEN_PR = { number: 12, state: 'OPEN', isDraft: false, title: 'Add the thing', url: 'https://gh/12' }

describe('pr-mirror', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    execFile.mockReset()
    setPullRequestChangeListener(() => {})
  })
  afterEach(() => vi.useRealTimers())

  it('serves repeat lookups from the cache within the TTL', async () => {
    ghReturns(OPEN_PR)
    await getPullRequest('/repo/a', 'feature')
    const again = await getPullRequest('/repo/a', 'feature')
    expect(again?.number).toBe(12)
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('shares one gh invocation between concurrent lookups', async () => {
    ghReturns(OPEN_PR)
    const [a, b] = await Promise.all([
      getPullRequest('/repo/concurrent', 'feature'),
      getPullRequest('/repo/concurrent', 'feature'),
    ])
    expect(a?.number).toBe(12)
    expect(b?.number).toBe(12)
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('marks a draft PR so the mirrored badge can tell it apart', async () => {
    ghReturns({ ...OPEN_PR, isDraft: true })
    expect((await getPullRequest('/repo/draft', 'feature'))?.state).toBe('DRAFT')
  })

  it('reports no PR when gh fails, and caches that answer', async () => {
    ghReturns(null)
    expect(await getPullRequest('/repo/none', 'feature')).toBeNull()
    expect(getCachedPullRequest('/repo/none', 'feature')).toBeUndefined()
    await getPullRequest('/repo/none', 'feature')
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('drops the cached PR when the tree switches branches', async () => {
    ghReturns(OPEN_PR)
    await getPullRequest('/repo/b', 'feature')
    // The mirror asks about the branch the tree is on NOW — an answer for the
    // previous branch must not keep drawing a badge on the new one.
    expect(getCachedPullRequest('/repo/b', 'other')).toBeUndefined()
    expect(getCachedPullRequest('/repo/b', 'feature')?.number).toBe(12)

    ghReturns({ ...OPEN_PR, number: 99 })
    await getPullRequest('/repo/b', 'other')
    expect(getCachedPullRequest('/repo/b', 'other')?.number).toBe(99)
  })

  it('re-fetches once the TTL expires', async () => {
    ghReturns(OPEN_PR)
    await getPullRequest('/repo/c', 'feature')
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    ghReturns({ ...OPEN_PR, state: 'MERGED' })
    expect((await getPullRequest('/repo/c', 'feature'))?.state).toBe('MERGED')
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('notifies only when the answer actually changed', async () => {
    const onChange = vi.fn()
    setPullRequestChangeListener(onChange)

    ghReturns(OPEN_PR)
    await getPullRequest('/repo/d', 'feature')
    expect(onChange).toHaveBeenCalledTimes(1) // unknown → open

    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    ghReturns(OPEN_PR)
    await getPullRequest('/repo/d', 'feature')
    expect(onChange).toHaveBeenCalledTimes(1) // same PR: no re-push

    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    ghReturns({ ...OPEN_PR, state: 'MERGED' })
    await getPullRequest('/repo/d', 'feature')
    expect(onChange).toHaveBeenCalledTimes(2) // merged: the badge has to change
  })

  it('has nothing to mirror for a tree it has never looked up', () => {
    expect(getCachedPullRequest('/repo/unseen', 'feature')).toBeUndefined()
    expect(getCachedPullRequest('/repo/unseen', undefined)).toBeUndefined()
  })
})
