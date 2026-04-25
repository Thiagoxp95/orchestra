import { useState, useEffect, useRef, useCallback } from 'react'
import { Tooltip } from './Tooltip'
import { UsageBar } from './UsageBar'
import { DynamicIcon } from './DynamicIcon'
import type { UsageSnapshot } from '../../../shared/types'

interface UsageBadgeProps {
  wsColor: string
  textColor: string
  onClick: () => void
}

interface ProviderUsage {
  label: string
  icon: string
  session: number | null
  weekly: number | null
  stale: boolean
  errorMsg: string | null
  isSyncing: boolean
}

// Minimum interval between hover-triggered refreshes. The main-process manager
// already dedupes concurrent probes via `isSyncing`, but capping the renderer
// side avoids flooding the IPC when the user moves the mouse on/off the badge.
const HOVER_REFRESH_MIN_INTERVAL_MS = 2_000

function getProviderUsage(snapshot: UsageSnapshot, provider: 'claude' | 'codex'): ProviderUsage {
  const state = snapshot[provider]
  const probe = state?.probe
  const isSyncing = !!state?.isSyncing
  // Always render both providers once the usage snapshot exists. A cold-start
  // Claude probe can be null while Codex already has data; hiding that state
  // makes Claude disappear from the footer until hover triggers a refresh.
  const s = probe?.session?.usedPercent ?? null
  const w = probe?.weekly?.usedPercent ?? null
  return {
    label: provider === 'claude' ? 'Claude' : 'Codex',
    icon: provider === 'claude' ? '__claude__' : '__openai__',
    session: s,
    weekly: w,
    stale: !!probe?.error,
    errorMsg: probe?.error ?? null,
    isSyncing,
  }
}

export function UsageBadge({ wsColor, textColor, onClick }: UsageBadgeProps) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const lastHoverRefreshRef = useRef(0)

  useEffect(() => {
    window.electronAPI.getUsageSnapshot().then(setSnapshot)
    const unsub = window.electronAPI.onUsageUpdate(setSnapshot)
    return unsub
  }, [])

  // Mirror ClaudeBar's `.task { await refresh(providerId:) }` on menu open:
  // refresh both providers when the badge is hovered so the popover and pill
  // numbers reflect the latest available data.
  const handleHover = useCallback(() => {
    const now = Date.now()
    if (now - lastHoverRefreshRef.current < HOVER_REFRESH_MIN_INTERVAL_MS) return
    lastHoverRefreshRef.current = now
    void window.electronAPI.refreshUsage()
  }, [])

  if (!snapshot) return null

  const claude = getProviderUsage(snapshot, 'claude')
  const codex = getProviderUsage(snapshot, 'codex')
  const providers = [claude, codex]

  const tooltipContent = (
    <div className="flex flex-col gap-1.5 min-w-[140px]">
      {providers.map((p) => (
        <div key={p.label} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold opacity-70">{p.label}</span>
            {p.isSyncing && (
              <span className="text-[9px] font-mono opacity-60">syncing…</span>
            )}
          </div>
          {p.session !== null && <UsageBar percent={p.session} label="Sess" textColor={textColor} />}
          {p.weekly !== null && <UsageBar percent={p.weekly} label="Week" textColor={textColor} />}
          {p.errorMsg && (
            <span className="text-[9px] font-mono opacity-60">{p.errorMsg}</span>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <Tooltip side="top" text={tooltipContent} bgColor={wsColor} textColor={textColor}>
      <button
        onClick={onClick}
        onMouseEnter={handleHover}
        onFocus={handleHover}
        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono transition-colors hover:opacity-80"
        style={{
          color: textColor,
          backgroundColor: `${textColor}10`,
          border: `1px solid ${textColor}18`,
        }}
      >
        {providers.map((p, i) => {
          const hasAny = p.session !== null || p.weekly !== null
          return (
            <span key={p.icon} className="flex items-center gap-0.5">
              {i > 0 && <span style={{ opacity: 0.3 }}>|</span>}
              <span style={{ opacity: p.stale ? 0.35 : 0.6 }}>
                <DynamicIcon name={p.icon} size={9} color={textColor} />
              </span>
              {!hasAny && (
                <span style={{ color: textColor, opacity: 0.5 }}>—</span>
              )}
              {p.session !== null && (
                <span style={{ color: textColor, opacity: p.stale ? 0.5 : 1 }}>
                  {Math.round(p.session)}%
                </span>
              )}
              {p.session !== null && p.weekly !== null && (
                <span style={{ opacity: 0.3 }}>/</span>
              )}
              {p.weekly !== null && (
                <span style={{ color: textColor, opacity: p.stale ? 0.5 : 1 }}>
                  {Math.round(p.weekly)}%
                </span>
              )}
            </span>
          )
        })}
      </button>
    </Tooltip>
  )
}
