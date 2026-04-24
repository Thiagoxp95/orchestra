import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanRecentCodexRateLimits } from './codex-usage-probe'

let baseDir: string

async function writeJsonl(relPath: string, lines: unknown[], mtimeSeconds?: number): Promise<string> {
  const full = join(baseDir, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, lines.map((l) => JSON.stringify(l)).join('\n'))
  if (mtimeSeconds !== undefined) {
    await utimes(full, mtimeSeconds, mtimeSeconds)
  }
  return full
}

function rateLimitsEvent(primaryPct: number, secondaryPct: number, resetsSeconds: number, timestamp?: string) {
  return {
    type: 'event_msg',
    timestamp: timestamp ?? new Date().toISOString(),
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: primaryPct, resets_at: resetsSeconds },
        secondary: { used_percent: secondaryPct, resets_at: resetsSeconds + 86400 },
      },
    },
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'orchestra-codex-probe-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('scanRecentCodexRateLimits', () => {
  it('returns no-sessions when directory is empty', async () => {
    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res).toEqual({ kind: 'no-sessions' })
  })

  it('returns no-sessions when directory does not exist', async () => {
    const res = await scanRecentCodexRateLimits({ baseDir: join(baseDir, 'missing') })
    expect(res).toEqual({ kind: 'no-sessions' })
  })

  it('returns rate limits from the newest session', async () => {
    const mtime = nowSeconds() - 60
    const ts = new Date(mtime * 1000).toISOString()
    await writeJsonl('a.jsonl', [rateLimitsEvent(12, 4, nowSeconds() + 3600, ts)], mtime)

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(12)
      expect(res.weekly?.usedPercent).toBe(4)
      expect(res.ageMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('falls through to the next newest file when newest has no rate_limits', async () => {
    const newerMtime = nowSeconds() - 10
    const olderMtime = nowSeconds() - 1000
    const olderTs = new Date(olderMtime * 1000).toISOString()

    await writeJsonl('newer.jsonl', [{ type: 'event_msg', payload: { type: 'chat' } }], newerMtime)
    await writeJsonl('older.jsonl', [rateLimitsEvent(50, 22, nowSeconds() + 3600, olderTs)], olderMtime)

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(50)
      expect(res.weekly?.usedPercent).toBe(22)
    }
  })

  it('scans nested session directories recursively', async () => {
    const mtime = nowSeconds() - 30
    const ts = new Date(mtime * 1000).toISOString()
    await writeJsonl('2026/04/23/x.jsonl', [rateLimitsEvent(7, 2, nowSeconds() + 3600, ts)], mtime)

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(7)
    }
  })

  it('returns no-recent-rate-limits when no file within window has rate_limits', async () => {
    await writeJsonl('a.jsonl', [{ type: 'event_msg', payload: { type: 'chat' } }])
    await writeJsonl('b.jsonl', [{ type: 'other' }])

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('no-recent-rate-limits')
  })

  it('stops after scanning the file budget', async () => {
    // 6 files all without rate_limits, then an older one with rate_limits.
    // With a budget of 5, the one with rate_limits should be skipped.
    for (let i = 0; i < 6; i++) {
      await writeJsonl(`empty-${i}.jsonl`, [{ type: 'event_msg', payload: {} }], nowSeconds() - i)
    }
    await writeJsonl('old-with-limits.jsonl', [rateLimitsEvent(99, 99, nowSeconds() + 3600)], nowSeconds() - 10_000)

    const res = await scanRecentCodexRateLimits({ baseDir, maxFiles: 5 })
    expect(res.kind).toBe('no-recent-rate-limits')
  })

  it('skips files older than the age cutoff', async () => {
    const ancient = nowSeconds() - 30 * 24 * 60 * 60
    await writeJsonl('ancient.jsonl', [rateLimitsEvent(99, 99, nowSeconds() + 3600)], ancient)

    const res = await scanRecentCodexRateLimits({ baseDir, maxAgeDays: 7 })
    expect(res.kind).toBe('no-sessions')
  })

  it('marks result as stale when matched event is older than stale threshold', async () => {
    const eightHoursAgoSec = nowSeconds() - 8 * 3600
    const ts = new Date(eightHoursAgoSec * 1000).toISOString()
    await writeJsonl('a.jsonl', [rateLimitsEvent(10, 5, nowSeconds() + 3600, ts)], eightHoursAgoSec)

    const res = await scanRecentCodexRateLimits({ baseDir, staleThresholdMs: 6 * 3600 * 1000 })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.stale).toBe(true)
    }
  })

  it('skips events where both primary and secondary are null (API-key mode)', async () => {
    const apiKeyEventTs = nowSeconds() - 60
    const subEventTs = nowSeconds() - 600

    // Newest file has an event with nulled primary/secondary — should be skipped.
    await writeJsonl(
      'newer.jsonl',
      [{
        type: 'event_msg',
        timestamp: new Date(apiKeyEventTs * 1000).toISOString(),
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'premium',
            primary: null,
            secondary: null,
            credits: { has_credits: false },
          },
        },
      }],
      apiKeyEventTs,
    )
    // Older file has a real subscription event — should be used instead.
    await writeJsonl(
      'older.jsonl',
      [rateLimitsEvent(33, 11, nowSeconds() + 3600, new Date(subEventTs * 1000).toISOString())],
      subEventTs,
    )

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(33)
      expect(res.weekly?.usedPercent).toBe(11)
    }
  })

  it('converts resets_at from unix seconds to ISO string', async () => {
    const mtime = nowSeconds() - 60
    const resetsAtSec = 1_900_000_000
    await writeJsonl('a.jsonl', [rateLimitsEvent(10, 5, resetsAtSec, new Date(mtime * 1000).toISOString())], mtime)

    const res = await scanRecentCodexRateLimits({ baseDir })
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(res.session?.resetsAt).toBe(new Date(resetsAtSec * 1000).toISOString())
    expect(res.weekly?.resetsAt).toBe(new Date((resetsAtSec + 86400) * 1000).toISOString())
  })
})
