import { useState, useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { textColor, isLightColor } from '../utils/color'
import { darkenColor } from './TerminalArea'
import { UsageBar } from './UsageBar'
import type { UsageSnapshot, UsageScanResult, UsageProbeResult, DailyTokenEntry, ModelTokenSummary } from '../../../shared/types'

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

function DailyChart({ entries, textColor: txtColor }: { entries: DailyTokenEntry[]; textColor: string }) {
  const last30 = entries.slice(-30)
  if (last30.length === 0) return null

  const totals = last30.map((e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens)
  const max = Math.max(...totals, 1)

  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex items-end gap-px h-[60px]" title="Last 30 days token usage">
      {last30.map((entry, i) => {
        const h = Math.max((totals[i] / max) * 100, 2)
        const isToday = entry.date === today
        return (
          <div
            key={entry.date}
            className="flex-1 rounded-t-sm transition-all duration-300"
            style={{
              height: `${h}%`,
              backgroundColor: isToday ? '#22c55e' : `${txtColor}30`,
              minWidth: 2,
            }}
            title={`${entry.date}: ${formatTokens(totals[i])} tokens`}
          />
        )
      })}
    </div>
  )
}

function ModelBreakdown({ models, textColor: txtColor }: { models: ModelTokenSummary[]; textColor: string }) {
  if (models.length === 0) return null

  const sorted = [...models].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold opacity-50" style={{ color: txtColor }}>
        Models
      </span>
      {sorted.map((m) => (
        <div key={m.model} className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono truncate flex-1 opacity-70" style={{ color: txtColor }}>
            {m.model}
          </span>
          <span className="text-[10px] font-mono shrink-0 opacity-50" style={{ color: txtColor }}>
            {formatTokens(m.inputTokens + m.outputTokens)}
          </span>
        </div>
      ))}
    </div>
  )
}

function ProviderSection({
  provider,
  probe,
  scan,
  txtColor,
  borderColor,
}: {
  provider: 'Claude' | 'Codex'
  probe: UsageProbeResult | null
  scan: UsageScanResult | null
  txtColor: string
  borderColor: string
}) {
  if (!probe && !scan) return null

  return (
    <div className="flex flex-col gap-2.5 py-3" style={{ borderBottom: `1px solid ${borderColor}` }}>
      <span className="text-xs font-semibold" style={{ color: txtColor, opacity: 0.8 }}>
        {provider}
      </span>

      {/* Rate limit bars */}
      {probe?.session && (
        <UsageBar percent={probe.session.usedPercent} label="Session" size="md" textColor={txtColor} />
      )}
      {probe?.weekly && (
        <UsageBar percent={probe.weekly.usedPercent} label="Weekly" size="md" textColor={txtColor} />
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

      {/* Model breakdown */}
      {scan && scan.modelBreakdown.length > 0 && (
        <ModelBreakdown models={scan.modelBreakdown} textColor={txtColor} />
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
  const [refreshing, setRefreshing] = useState(false)

  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = activeWorkspace?.color ?? '#2a2a3e'
  const panelBg = darkenColor(wsColor)
  const txtColor = textColor(wsColor)
  const borderColor = isLightColor(wsColor) ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.08)'

  useEffect(() => {
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await window.electronAPI.refreshUsage()
      const fresh = await window.electronAPI.getUsageSnapshot()
      setSnapshot(fresh)
    } finally {
      setRefreshing(false)
    }
  }

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
            disabled={refreshing}
            className="p-0.5 rounded hover:opacity-80 transition-opacity disabled:opacity-30"
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
              className={refreshing ? 'animate-spin' : ''}
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
              probe={snapshot.claude.probe}
              scan={snapshot.claude.scan}
              txtColor={txtColor}
              borderColor={borderColor}
            />
            <ProviderSection
              provider="Codex"
              probe={snapshot.codex.probe}
              scan={snapshot.codex.scan}
              txtColor={txtColor}
              borderColor={borderColor}
            />
          </>
        )}
      </div>
    </div>
  )
}
