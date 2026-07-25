// Compacts the desktop's usage snapshot for the web mirror.
//
// The full UsageSnapshot carries scan data (per-model token counts, 30 days of
// daily usage, cost estimates) that the phone has no room to show and no reason
// to receive — the mirror only needs "how close is each rate-limit window to
// full", the same thing the desktop footer badge renders.
//
// `isSyncing` is deliberately dropped: it flips true/false twice per probe, and
// the Codex probe runs every 15s. Mirroring it would turn every poll into a
// state push for a value nothing on the web renders.

import type { RateWindow, ScopedRateWindow, UsageProviderId, UsageSnapshot } from '../shared/types'

export interface MirroredUsageWindow {
  usedPercent: number
  resetText: string | null
}

export interface MirroredUsageScoped extends MirroredUsageWindow {
  label: string
  severity: ScopedRateWindow['severity']
}

export interface MirroredUsageProvider {
  session: MirroredUsageWindow | null
  weekly: MirroredUsageWindow | null
  scoped: MirroredUsageScoped[]
  /** A probe error is in effect — the numbers below are the last good ones. */
  stale: boolean
  updatedAt: number | null
}

export type MirroredUsage = Record<UsageProviderId, MirroredUsageProvider>

const PROVIDERS: UsageProviderId[] = ['claude', 'codex']

function compactWindow(w: RateWindow | null | undefined): MirroredUsageWindow | null {
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null
  return { usedPercent: w.usedPercent, resetText: w.resetText ?? null }
}

function compactProvider(snapshot: UsageSnapshot, provider: UsageProviderId): MirroredUsageProvider {
  const probe = snapshot[provider]?.probe
  return {
    session: compactWindow(probe?.session),
    weekly: compactWindow(probe?.weekly),
    scoped: (probe?.scoped ?? []).flatMap((s) => {
      const w = compactWindow(s)
      return w ? [{ ...w, label: s.label, severity: s.severity }] : []
    }),
    stale: !!probe?.error,
    updatedAt: probe?.updatedAt ?? null,
  }
}

function hasData(p: MirroredUsageProvider): boolean {
  return p.session !== null || p.weekly !== null || p.scoped.length > 0
}

/**
 * Mirror payload for the usage snapshot, or null when neither provider has any
 * numbers yet (cold start, both probes failed) — nothing for the phone to draw.
 */
export function sanitizeUsage(snapshot: UsageSnapshot | null | undefined): MirroredUsage | null {
  if (!snapshot) return null
  const out = {} as MirroredUsage
  for (const provider of PROVIDERS) out[provider] = compactProvider(snapshot, provider)
  return PROVIDERS.some((p) => hasData(out[p])) ? out : null
}

/**
 * Change key for the compacted payload. State pushes are change-triggered, and a
 * probe that returns identical numbers (the common case — Codex re-scans every
 * 15s, and percentages move slowly) must not cost a push. `updatedAt` is
 * excluded on purpose: it advances on every probe even when nothing moved.
 */
export function usageFingerprint(usage: MirroredUsage | null): string {
  if (!usage) return ''
  return PROVIDERS.map((id) => {
    const p = usage[id]
    const win = (w: MirroredUsageWindow | null) => (w ? `${w.usedPercent}:${w.resetText ?? ''}` : '-')
    const scoped = p.scoped.map((s) => `${s.label}=${s.usedPercent}/${s.severity}`).join(',')
    return `${id}[${win(p.session)}|${win(p.weekly)}|${scoped}|${p.stale ? 'stale' : 'ok'}]`
  }).join(';')
}
