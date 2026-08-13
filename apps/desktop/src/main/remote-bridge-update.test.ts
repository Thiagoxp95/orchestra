import { describe, expect, it } from 'vitest'
import {
  buildMirroredUpdate,
  planRestartToUpdate,
  quantizePercent,
  updateFingerprint,
  type MirroredUpdateInput,
} from './remote-bridge-update'

const base: MirroredUpdateInput = {
  status: null,
  downloadedVersion: null,
  currentVersion: '1.21.47',
  supported: true,
  restartPending: false,
}

describe('buildMirroredUpdate', () => {
  it('reports idle with nothing to install before the first check', () => {
    const out = buildMirroredUpdate(base)
    expect(out.state).toBe('idle')
    expect(out.updateAvailable).toBe(false)
    expect(out.updateDownloaded).toBe(false)
    expect(out.currentVersion).toBe('1.21.47')
    expect(out.availableVersion).toBeNull()
  })

  it('marks a build with no update channel unsupported', () => {
    expect(buildMirroredUpdate({ ...base, supported: false }).supported).toBe(false)
  })

  it('reports available (not yet installable) while a release is downloading', () => {
    const out = buildMirroredUpdate({
      ...base,
      status: { status: 'downloading', version: '1.21.48', percent: 42 },
    })
    expect(out.updateAvailable).toBe(true)
    expect(out.updateDownloaded).toBe(false)
    expect(out.availableVersion).toBe('1.21.48')
    expect(out.percent).toBe(40)
  })

  it('reports a staged update as installable', () => {
    const out = buildMirroredUpdate({
      ...base,
      status: { status: 'downloaded', version: '1.21.48' },
      downloadedVersion: '1.21.48',
    })
    expect(out.updateAvailable).toBe(true)
    expect(out.updateDownloaded).toBe(true)
    expect(out.availableVersion).toBe('1.21.48')
    expect(out.percent).toBeNull()
  })

  it('keeps a staged update installable across a later background re-check', () => {
    // The 30-minute check flips status to 'checking' then 'not-available' while
    // the downloaded artifact is still on disk. If the mirror followed status
    // alone the phone's button would vanish and a restart would install nothing.
    for (const state of ['checking', 'not-available'] as const) {
      const out = buildMirroredUpdate({
        ...base,
        status: { status: state },
        downloadedVersion: '1.21.48',
      })
      expect(out.updateDownloaded).toBe(true)
      expect(out.updateAvailable).toBe(true)
      expect(out.availableVersion).toBe('1.21.48')
    }
  })

  it('surfaces only the friendly copy for an error, and only while erroring', () => {
    const errored = buildMirroredUpdate({
      ...base,
      status: { status: 'error', message: 'Update failed', detail: 'ENOTFOUND raw stack' },
    })
    expect(errored.message).toBe('Update failed')
    const ok = buildMirroredUpdate({ ...base, status: { status: 'not-available' } })
    expect(ok.message).toBeNull()
  })

  it('carries the restart latch through to the mirror', () => {
    const out = buildMirroredUpdate({
      ...base,
      status: { status: 'downloaded', version: '1.21.48' },
      downloadedVersion: '1.21.48',
      restartPending: true,
    })
    expect(out.restartPending).toBe(true)
  })
})

describe('quantizePercent', () => {
  it('rounds to 10% steps so a download costs at most ten pushes', () => {
    expect(quantizePercent(0)).toBe(0)
    expect(quantizePercent(4)).toBe(0)
    expect(quantizePercent(5)).toBe(10)
    expect(quantizePercent(97)).toBe(100)
  })

  it('clamps out-of-range and non-numeric progress', () => {
    expect(quantizePercent(-5)).toBe(0)
    expect(quantizePercent(140)).toBe(100)
    expect(quantizePercent(Number.NaN)).toBeNull()
    expect(quantizePercent(undefined)).toBeNull()
  })
})

describe('updateFingerprint', () => {
  it('does not move for progress inside the same 10% step', () => {
    const a = buildMirroredUpdate({ ...base, status: { status: 'downloading', percent: 41 } })
    const b = buildMirroredUpdate({ ...base, status: { status: 'downloading', percent: 44 } })
    expect(updateFingerprint(a)).toBe(updateFingerprint(b))
  })

  it('moves when the download crosses a step', () => {
    const a = buildMirroredUpdate({ ...base, status: { status: 'downloading', percent: 41 } })
    const b = buildMirroredUpdate({ ...base, status: { status: 'downloading', percent: 56 } })
    expect(updateFingerprint(a)).not.toBe(updateFingerprint(b))
  })

  it('moves the moment an update becomes installable', () => {
    const before = buildMirroredUpdate({ ...base, status: { status: 'downloading', percent: 100 } })
    const after = buildMirroredUpdate({
      ...base,
      status: { status: 'downloaded', version: '1.21.48' },
      downloadedVersion: '1.21.48',
    })
    expect(updateFingerprint(before)).not.toBe(updateFingerprint(after))
  })

  it('moves when the restart is accepted', () => {
    const staged: MirroredUpdateInput = {
      ...base,
      status: { status: 'downloaded', version: '1.21.48' },
      downloadedVersion: '1.21.48',
    }
    expect(updateFingerprint(buildMirroredUpdate(staged))).not.toBe(
      updateFingerprint(buildMirroredUpdate({ ...staged, restartPending: true })),
    )
  })

  it('is empty for no payload at all', () => {
    expect(updateFingerprint(null)).toBe('')
  })
})

describe('planRestartToUpdate', () => {
  it('installs when an update is staged', () => {
    expect(planRestartToUpdate({ supported: true, downloaded: true, restartPending: false }))
      .toEqual({ action: 'install' })
  })

  it('checks instead of failing silently when nothing is staged', () => {
    expect(planRestartToUpdate({ supported: true, downloaded: false, restartPending: false }))
      .toEqual({ action: 'check', reason: 'not-downloaded' })
  })

  it('does nothing in a build with no update channel', () => {
    expect(planRestartToUpdate({ supported: false, downloaded: false, restartPending: false }))
      .toEqual({ action: 'none', reason: 'unsupported' })
  })

  it('refuses a second restart while the first is in flight', () => {
    // The idempotency guard: two taps on the phone are two distinct command
    // rows, so the drain's per-id dedup cannot catch this one.
    expect(planRestartToUpdate({ supported: true, downloaded: true, restartPending: true }))
      .toEqual({ action: 'none', reason: 'already-restarting' })
  })

  it('keeps refusing even if the staged update disappears mid-restart', () => {
    expect(planRestartToUpdate({ supported: true, downloaded: false, restartPending: true }))
      .toEqual({ action: 'none', reason: 'already-restarting' })
  })
})
