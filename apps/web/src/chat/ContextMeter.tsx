'use client'
import { useRef, useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { AnchoredPopover } from './Popover'
import type { ChatContextUsage } from './transport'

// t3code's ContextWindowMeter: a ring gauge in the composer footer that opens
// a detail card (usage bar, token counts, Compact context).

const RADIUS = 9.75
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value < 1_000) return `${Math.round(value)}`
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

function formatPercent(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(value)}%`
}

export function ContextMeter({
  usage,
  onCompact,
  compactDisabled,
}: {
  usage: ChatContextUsage
  onCompact?: () => void
  compactDisabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  if (!(usage.contextWindow > 0)) return null
  const percent = Math.max(0, Math.min(100, (usage.usedTokens / usage.contextWindow) * 100))
  const overloaded = percent > 90
  const color = overloaded
    ? 'var(--destructive)'
    : 'color-mix(in oklab, var(--muted-foreground) 72%, transparent)'
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Context window ${formatPercent(percent)} used`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-hover"
      >
        <span className="relative flex size-5 items-center justify-center">
          <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90" aria-hidden>
            <circle cx={12} cy={12} r={RADIUS} fill="none" strokeWidth={3} style={{ stroke: 'color-mix(in srgb, var(--muted-foreground) 24%, transparent)' }} />
            <circle
              cx={12}
              cy={12}
              r={RADIUS}
              fill="none"
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
              className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
            />
          </svg>
        </span>
      </button>
      {open && anchorRef.current && (
        <AnchoredPopover anchor={anchorRef.current} width={240} align="end" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-muted-foreground">Context Window</div>
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {formatPercent(percent)}
                <span className="mx-1">·</span>
                {formatTokens(usage.usedTokens)}/{formatTokens(usage.contextWindow)}
              </div>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              aria-label="Context window usage"
            >
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${percent}%`, backgroundColor: color }} />
            </div>
            {onCompact && (
              <button
                type="button"
                disabled={compactDisabled}
                onClick={() => {
                  setOpen(false)
                  onCompact()
                }}
                className="mt-1 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border text-xs text-foreground hover:bg-surface-hover disabled:opacity-40"
              >
                <Minimize2 className="size-3.5" />
                Compact context
              </button>
            )}
          </div>
        </AnchoredPopover>
      )}
    </>
  )
}
