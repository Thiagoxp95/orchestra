import { useState, useEffect } from 'react'
import { Tooltip } from './Tooltip'
import { UsageBar } from './UsageBar'
import { DynamicIcon } from './DynamicIcon'
import type { UsageSnapshot } from '../../../shared/types'

interface UsageBadgeProps {
  wsColor: string
  textColor: string
  onClick: () => void
}

function statusColor(percent: number): string {
  if (percent >= 80) return '#ef4444'
  if (percent >= 50) return '#eab308'
  return '#22c55e'
}

interface ProviderUsage {
  label: string
  icon: string
  session: number | null
  weekly: number | null
  stale: boolean
}

function getProviderUsage(snapshot: UsageSnapshot, provider: 'claude' | 'codex'): ProviderUsage | null {
  const probe = snapshot[provider]?.probe
  if (!probe) return null
  const s = probe.session?.usedPercent ?? null
  const w = probe.weekly?.usedPercent ?? null
  if (s === null && w === null) return null
  return {
    label: provider === 'claude' ? 'Claude' : 'Codex',
    icon: provider === 'claude' ? '__claude__' : '__openai__',
    session: s,
    weekly: w,
    stale: probe.error === 'stale',
  }
}

export function UsageBadge({ wsColor, textColor, onClick }: UsageBadgeProps) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)

  useEffect(() => {
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  if (!snapshot) return null

  const claude = getProviderUsage(snapshot, 'claude')
  const codex = getProviderUsage(snapshot, 'codex')
  const providers = [claude, codex].filter((p): p is ProviderUsage => p !== null)

  if (providers.length === 0) return null

  const tooltipContent = (
    <div className="flex flex-col gap-1.5 min-w-[140px]">
      {providers.map((p) => (
        <div key={p.label} className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold opacity-70">
            {p.label}{p.stale ? ' (stale)' : ''}
          </span>
          {p.session !== null && <UsageBar percent={p.session} label="Sess" textColor={textColor} />}
          {p.weekly !== null && <UsageBar percent={p.weekly} label="Week" textColor={textColor} />}
        </div>
      ))}
    </div>
  )

  return (
    <Tooltip side="top" text={tooltipContent} bgColor={wsColor} textColor={textColor}>
      <button
        onClick={onClick}
        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:opacity-80"
        style={{
          color: textColor,
          backgroundColor: `${textColor}10`,
          border: `1px solid ${textColor}18`,
        }}
      >
        {providers.map((p, i) => (
          <span key={p.icon} className="flex items-center gap-0.5">
            {i > 0 && <span style={{ opacity: 0.3 }}>|</span>}
            <span style={{ opacity: p.stale ? 0.35 : 0.6 }}>
              <DynamicIcon name={p.icon} size={9} color={textColor} />
            </span>
            {p.session !== null && (
              <span style={{ color: statusColor(p.session), opacity: p.stale ? 0.5 : 1 }}>
                {Math.round(p.session)}%
              </span>
            )}
            {p.session !== null && p.weekly !== null && (
              <span style={{ opacity: 0.3 }}>/</span>
            )}
            {p.weekly !== null && (
              <span style={{ color: statusColor(p.weekly), opacity: p.stale ? 0.5 : 1 }}>
                {Math.round(p.weekly)}%
              </span>
            )}
          </span>
        ))}
      </button>
    </Tooltip>
  )
}
