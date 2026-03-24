import { useState, useEffect } from 'react'
import { Tooltip } from './Tooltip'
import { UsageBar } from './UsageBar'
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

function pickPercent(snapshot: UsageSnapshot, kind: 'session' | 'weekly'): { label: string; percent: number } | null {
  // Prefer Claude data, fall back to Codex
  for (const provider of ['claude', 'codex'] as const) {
    const probe = snapshot[provider]?.probe
    if (!probe) continue
    const window = kind === 'session' ? probe.session : probe.weekly
    if (window) return { label: provider === 'claude' ? 'Claude' : 'Codex', percent: window.usedPercent }
  }
  return null
}

export function UsageBadge({ wsColor, textColor, onClick }: UsageBadgeProps) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)

  useEffect(() => {
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  if (!snapshot) return null

  const session = pickPercent(snapshot, 'session')
  const weekly = pickPercent(snapshot, 'weekly')

  if (!session && !weekly) return null

  const tooltipContent = (
    <div className="flex flex-col gap-1.5 min-w-[140px]">
      {(['claude', 'codex'] as const).map((provider) => {
        const probe = snapshot[provider]?.probe
        if (!probe) return null
        const s = probe.session
        const w = probe.weekly
        if (!s && !w) return null
        return (
          <div key={provider} className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold opacity-70">
              {provider === 'claude' ? 'Claude' : 'Codex'}
            </span>
            {s && <UsageBar percent={s.usedPercent} label="Sess" textColor={textColor} />}
            {w && <UsageBar percent={w.usedPercent} label="Week" textColor={textColor} />}
          </div>
        )
      })}
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
        {session && (
          <span className="flex items-center gap-1">
            <span style={{ opacity: 0.5 }}>S:</span>
            <span style={{ color: statusColor(session.percent) }}>{Math.round(session.percent)}%</span>
          </span>
        )}
        {session && weekly && <span style={{ opacity: 0.3 }}>|</span>}
        {weekly && (
          <span className="flex items-center gap-1">
            <span style={{ opacity: 0.5 }}>W:</span>
            <span style={{ color: statusColor(weekly.percent) }}>{Math.round(weekly.percent)}%</span>
          </span>
        )}
      </button>
    </Tooltip>
  )
}
