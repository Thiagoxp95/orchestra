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

  it('walks past a streak of content-less rate_limits events to find the last real snapshot', async () => {
    // Exercise the file-budget: a streak of sessions that produce token_count
    // events without usable primary/secondary data (and without the blocked
    // signal either — pure noise) must not hide the older subscription
    // snapshot beyond the 5-file default budget.
    const realSessionTs = nowSeconds() - 3600
    const realTs = new Date(realSessionTs * 1000).toISOString()
    await writeJsonl(
      'real.jsonl',
      [rateLimitsEvent(60, 23, nowSeconds() + 3600, realTs)],
      realSessionTs,
    )
    for (let i = 0; i < 10; i++) {
      const mtime = nowSeconds() - 60 * (10 - i)
      await writeJsonl(
        `noise-${i}.jsonl`,
        [{
          type: 'event_msg',
          timestamp: new Date(mtime * 1000).toISOString(),
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: { primary: null, secondary: null },
          },
        }],
        mtime,
      )
    }

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(60)
      expect(res.weekly?.usedPercent).toBe(23)
    }
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

    // API-key sessions emit token_count with null primary/secondary and
    // without the subscription-blocked indicators (no limit_id, no credits).
    // These must be skipped entirely — not treated as "blocked" overrides.
    await writeJsonl(
      'newer.jsonl',
      [{
        type: 'event_msg',
        timestamp: new Date(apiKeyEventTs * 1000).toISOString(),
        payload: {
          type: 'token_count',
          rate_limits: { primary: null, secondary: null },
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

  it('overrides primary to 100% when a blocked (premium/no-credits) signal is newer than the subscription snapshot', async () => {
    // Codex flips rate_limits.limit_id from "codex" → "premium" with
    // credits.has_credits=false the moment the user hits the 5h window on a
    // Plus plan with no overage budget. Real world log order within one
    // session: good 61% → good 61% → blocked.
    const goodTs = nowSeconds() - 600
    const blockedTs = nowSeconds() - 300
    await writeJsonl(
      'mixed.jsonl',
      [
        {
          type: 'event_msg',
          timestamp: new Date(goodTs * 1000).toISOString(),
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: 61, resets_at: nowSeconds() + 3600 },
              secondary: { used_percent: 23, resets_at: nowSeconds() + 86400 },
              plan_type: 'plus',
              credits: null,
            },
          },
        },
        {
          type: 'event_msg',
          timestamp: new Date(blockedTs * 1000).toISOString(),
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'premium',
              primary: null,
              secondary: null,
              plan_type: 'plus',
              credits: { has_credits: false, unlimited: false, balance: '0' },
            },
          },
        },
      ],
      blockedTs,
    )

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(100)
      // Weekly (secondary) should keep its real value — only primary is blocked.
      expect(res.weekly?.usedPercent).toBe(23)
    }
  })

  it('keeps subscription percentages when the blocked signal is older than the snapshot', async () => {
    // Previous-window blocked event that has since been followed by a fresh
    // subscription snapshot (new 5h window reset). The blocked signal is
    // stale and must NOT override the current percentage.
    const oldBlockedTs = nowSeconds() - 7200
    const freshGoodTs = nowSeconds() - 60
    await writeJsonl(
      'older-blocked.jsonl',
      [{
        type: 'event_msg',
        timestamp: new Date(oldBlockedTs * 1000).toISOString(),
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
      oldBlockedTs,
    )
    await writeJsonl(
      'newer-good.jsonl',
      [rateLimitsEvent(12, 8, nowSeconds() + 3600, new Date(freshGoodTs * 1000).toISOString())],
      freshGoodTs,
    )

    const res = await scanRecentCodexRateLimits({ baseDir })
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.session?.usedPercent).toBe(12)
      expect(res.weekly?.usedPercent).toBe(8)
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
