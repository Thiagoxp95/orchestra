import { useState, useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'
import { UsageBar } from './UsageBar'
import { formatResetText } from '../../../shared/usage-format'
import type {
  RateWindow,
  UsageSnapshot,
  UsageScanResult,
  UsageProbeResult,
  UsageProviderId,
  DailyTokenEntry,
} from '../../../shared/types'

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

// Probe-time `resetText` is the canonical value (matches ClaudeBar's
// `quota.resetText` model field). We recompute live from `resetsAt` here so
// the displayed countdown updates between refreshes, falling back to the
// probe-supplied text if the absolute timestamp is missing.
function liveResetText(window: RateWindow | null): string | null {
  if (!window) return null
  return formatResetText(window.resetsAt) ?? window.resetText
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function DailyChart({ entries, textColor: txtColor }: { entries: DailyTokenEntry[]; textColor: string }) {
  if (entries.length === 0) return null

  const totalByDate = new Map<string, number>()
  for (const e of entries) {
    totalByDate.set(e.date, e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens)
  }

  // Render one bar per calendar day across the last 30 days, zero-padding
  // days without activity. Providers with sparse usage (Codex when used
  // occasionally) otherwise get a handful of wide bars instead of a real
  // time series.
  const today = new Date()
  const days: { date: string; total: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = localDateKey(d)
    days.push({ date: key, total: totalByDate.get(key) ?? 0 })
  }

  const max = Math.max(...days.map((d) => d.total), 1)
  const todayKey = localDateKey(today)

  return (
    <div className="flex items-end gap-px h-[60px]" title="Last 30 days token usage">
      {days.map(({ date, total }) => {
        const h = total > 0 ? Math.max((total / max) * 100, 2) : 2
        const isToday = date === todayKey
        return (
          <div
            key={date}
            className="flex-1 rounded-t-sm transition-all duration-300"
            style={{
              height: `${h}%`,
              backgroundColor: isToday ? '#22c55e' : `${txtColor}30`,
              minWidth: 2,
              opacity: total > 0 ? 1 : 0.35,
            }}
            title={`${date}: ${formatTokens(total)} tokens`}
          />
        )
      })}
    </div>
  )
}

function ProviderSection({
  provider,
  providerId,
  probe,
  scan,
  isSyncing,
  txtColor,
  borderColor,
  onFocus,
}: {
  provider: 'Claude' | 'Codex'
  providerId: UsageProviderId
  probe: UsageProbeResult | null
  scan: UsageScanResult | null
  isSyncing: boolean
  txtColor: string
  borderColor: string
  onFocus: (providerId: UsageProviderId) => void
}) {
  if (!probe && !scan && !isSyncing) return null

  return (
    <div
      className="flex flex-col gap-2.5 py-3"
      style={{ borderBottom: `1px solid ${borderColor}` }}
      onClick={() => onFocus(providerId)}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: txtColor, opacity: 0.8 }}>
          {provider}
        </span>
        {isSyncing && (
          <span className="text-[9px] font-mono opacity-50" style={{ color: txtColor }}>
            syncing…
          </span>
        )}
      </div>

      {/* Rate limit bars */}
      {probe?.session && (
        <div className="flex flex-col gap-0.5">
          <UsageBar percent={probe.session.usedPercent} label="Session" size="md" textColor={txtColor} />
          {liveResetText(probe.session) && (
            <span className="text-[9px] font-mono opacity-35 pl-[52px]" style={{ color: txtColor }}>
              {liveResetText(probe.session)}
            </span>
          )}
        </div>
      )}
      {probe?.weekly && (
        <div className="flex flex-col gap-0.5">
          <UsageBar percent={probe.weekly.usedPercent} label="Weekly" size="md" textColor={txtColor} />
          {liveResetText(probe.weekly) && (
            <span className="text-[9px] font-mono opacity-35 pl-[52px]" style={{ color: txtColor }}>
              {liveResetText(probe.weekly)}
            </span>
          )}
        </div>
      )}
      {probe?.error && (
        <span className="text-[10px] font-mono opacity-40" style={{ color: txtColor }}>
          {probe.error}
        </span>
      )}

      {/* Today stats grid */}
      {scan && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <StatCell label="Messages" value={String(scan.todayMessages)} txtColor={txtColor} />
          <StatCell label="Cost" value={formatCost(scan.todayCostEstimate)} txtColor={txtColor} />
          <StatCell label="Tokens in" value={formatTokens(scan.todayTokensIn)} txtColor={txtColor} />
          <StatCell label="Tokens out" value={formatTokens(scan.todayTokensOut)} txtColor={txtColor} />
        </div>
      )}

      {/* 30-day chart */}
      {scan && scan.last30Days.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold opacity-50" style={{ color: txtColor }}>
            Last 30 days
          </span>
          <DailyChart entries={scan.last30Days} textColor={txtColor} />
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, txtColor }: { label: string; value: string; txtColor: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-mono opacity-40" style={{ color: txtColor }}>
        {label}
      </span>
      <span className="text-xs font-mono" style={{ color: txtColor }}>
        {value}
      </span>
    </div>
  )
}

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'

  useEffect(() => {
    // Mirror ClaudeBar's `.task { await refresh(providerId:) }` — always
    // trigger a fresh probe when the panel mounts so the displayed numbers
    // are as up-to-date as the rate limit allows.
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    void window.electronAPI.refreshUsage()
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  const handleRefresh = () => {
    // No client-side gating — manual refresh always fires (matches
    // ClaudeBar's keyboard-shortcut "r" behavior). isSyncing comes from the
    // main-process snapshot, which dedupes concurrent in-flight probes.
    void window.electronAPI.refreshUsage()
  }

  const handleFocusProvider = (providerId: UsageProviderId) => {
    void window.electronAPI.refreshUsage(providerId)
  }

  const anySyncing = !!(snapshot && (snapshot.claude.isSyncing || snapshot.codex.isSyncing))
  const hasData = snapshot && (snapshot.claude.probe || snapshot.claude.scan || snapshot.codex.probe || snapshot.codex.scan)

  return (
    <div
      className="w-[280px] shrink-0 flex flex-col overflow-hidden ml-2"
      style={{ backgroundColor: panelBg, borderLeft: `1px solid ${borderColor}` }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${borderColor}` }}
      >
        <span className="text-xs font-semibold" style={{ color: txtColor, opacity: 0.7 }}>
          Usage
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="p-0.5 rounded hover:opacity-80 transition-opacity"
            style={{ color: txtColor, opacity: 0.5 }}
            title="Refresh usage data"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className={anySyncing ? 'animate-spin' : ''}
            >
              <path d="M2 8a6 6 0 0 1 10.3-4.2" />
              <path d="M14 8a6 6 0 0 1-10.3 4.2" />
              <polyline points="2 2 2 6 6 6" />
              <polyline points="14 14 14 10 10 10" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:opacity-80 transition-opacity"
            style={{ color: txtColor, opacity: 0.5 }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3">
        {!hasData && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs" style={{ color: txtColor, opacity: 0.4 }}>
              No usage data yet
            </span>
          </div>
        )}
        {hasData && (
          <>
            <ProviderSection
              provider="Claude"
              providerId="claude"
              probe={snapshot.claude.probe}
              scan={snapshot.claude.scan}
              isSyncing={snapshot.claude.isSyncing}
              txtColor={txtColor}
              borderColor={borderColor}
              onFocus={handleFocusProvider}
            />
            <ProviderSection
              provider="Codex"
              providerId="codex"
              probe={snapshot.codex.probe}
              scan={snapshot.codex.scan}
              isSyncing={snapshot.codex.isSyncing}
              txtColor={txtColor}
              borderColor={borderColor}
              onFocus={handleFocusProvider}
            />
          </>
        )}
      </div>
    </div>
  )
}
