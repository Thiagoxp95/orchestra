// Provider rate-limit usage as mirrored from the desktop (remoteState.usage,
// built by the desktop's remote-bridge-usage.ts). Shaped for the bottom strip:
// one chip per provider, one meter per rate-limit window.
//
// Everything here treats the mirrored payload as untrusted `unknown` — it is
// whatever the desktop last wrote, which may predate any field added since.

export type UsageLevel = 'normal' | 'warning' | 'critical'

export interface UsageMeter {
  key: string
  /** Full name — 'Sess', 'Week', or the scoped window's own name. Used in the summary. */
  label: string
  /**
   * Label to actually draw in the strip, or null to draw the bar alone. The two
   * standard windows always appear in the same order (session then weekly) and
   * the desktop pill labels neither, so spelling them out on a phone costs ~60px
   * of a ~380px row to say what position already says. Scoped caps keep their
   * name — 'Fable' is the whole point of that entry.
   */
  inlineLabel: string | null
  percent: number // clamped 0-100
  level: UsageLevel
  resetText: string | null
}

export interface UsageChip {
  id: 'claude' | 'codex'
  name: string
  icon: string
  /** A probe error is in effect: these are the last good numbers, not live. */
  stale: boolean
  meters: UsageMeter[]
  /** Flat description for the title / aria-label (no hover on a phone). */
  summary: string
}

// Same thresholds and palette as the desktop's UsageBar, so a window that reads
// yellow in the Electron footer reads yellow on the phone.
const LEVEL_COLOR: Record<UsageLevel, string> = {
  critical: '#ef4444',
  warning: '#eab308',
  normal: '#22c55e',
}
const LEVEL_RANK: Record<UsageLevel, number> = { normal: 0, warning: 1, critical: 2 }

const PROVIDERS = [
  { id: 'claude', name: 'Claude', icon: '__claude__' },
  { id: 'codex', name: 'Codex', icon: '__openai__' },
] as const

function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function levelFromPercent(percent: number): UsageLevel {
  if (percent >= 80) return 'critical'
  if (percent >= 50) return 'warning'
  return 'normal'
}

/**
 * A window's level is the worse of what its percentage implies and what the API
 * said about it. Anthropic marks a scoped cap critical before it reads 80% (it
 * knows the burn rate), and we never want to paint that one green — but a 95%
 * window the API still calls 'normal' is not green either.
 */
export function resolveLevel(percent: number, severity?: unknown): UsageLevel {
  const byPercent = levelFromPercent(percent)
  const claimed =
    severity === 'critical' || severity === 'warning' || severity === 'normal'
      ? (severity as UsageLevel)
      : 'normal'
  return LEVEL_RANK[claimed] > LEVEL_RANK[byPercent] ? claimed : byPercent
}

export function levelColor(level: UsageLevel): string {
  return LEVEL_COLOR[level]
}

function readWindow(
  raw: unknown,
  key: string,
  label: string,
  inlineLabel: string | null,
): UsageMeter | null {
  if (!raw || typeof raw !== 'object') return null
  const percent = clampPercent((raw as { usedPercent?: unknown }).usedPercent)
  if (percent === null) return null
  const resetText = (raw as { resetText?: unknown }).resetText
  return {
    key,
    label,
    inlineLabel,
    percent,
    level: resolveLevel(percent, (raw as { severity?: unknown }).severity),
    resetText: typeof resetText === 'string' && resetText ? resetText : null,
  }
}

/**
 * One chip per provider that has at least one usable window. Providers with no
 * data are dropped rather than rendered as a placeholder — the phone strip is
 * ~20px of screen and an empty entry is just noise there.
 */
export function selectUsageChips(usage: unknown): UsageChip[] {
  if (!usage || typeof usage !== 'object') return []
  const chips: UsageChip[] = []

  for (const provider of PROVIDERS) {
    const raw = (usage as Record<string, unknown>)[provider.id]
    if (!raw || typeof raw !== 'object') continue
    const p = raw as { session?: unknown; weekly?: unknown; scoped?: unknown; stale?: unknown }

    const meters: UsageMeter[] = []
    const session = readWindow(p.session, 'session', 'Sess', null)
    if (session) meters.push(session)
    const weekly = readWindow(p.weekly, 'weekly', 'Week', null)
    if (weekly) meters.push(weekly)
    if (Array.isArray(p.scoped)) {
      for (const entry of p.scoped) {
        const label = (entry as { label?: unknown })?.label
        if (typeof label !== 'string' || !label) continue
        const meter = readWindow(entry, `scoped:${label}`, label, label)
        if (meter) meters.push(meter)
      }
    }
    if (meters.length === 0) continue

    const detail = meters
      .map((m) => `${m.label} ${Math.round(m.percent)}%${m.resetText ? ` (${m.resetText})` : ''}`)
      .join(', ')
    chips.push({
      id: provider.id,
      name: provider.name,
      icon: provider.icon,
      stale: !!p.stale,
      meters,
      summary: `${provider.name} usage — ${detail}${p.stale ? ' (last known)' : ''}`,
    })
  }

  return chips
}

/** True when anything worth mirroring exists — drives the bottom bar's layout. */
export function hasUsage(usage: unknown): boolean {
  return selectUsageChips(usage).length > 0
}
