'use client'
import { useState } from 'react'
import { useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { DynamicIcon } from './DynamicIcon'
import { ResumeSheet, ResumeGlyph } from './ResumeSheet'
import { selectUsageChips, levelColor, type UsageChip, type UsageMeter } from '@/lib/usage'

/**
 * Bottom-most strip: how close each provider is to its rate limits, mirrored
 * from the desktop's usage-manager (the same numbers the Electron footer badge
 * shows), plus the Resume button on the right — the phone's counterpart to the
 * desktop footer, where those two sit side by side too. It lives in the space
 * the home-indicator padding was already reserving, so it costs no terminal
 * height on a phone.
 *
 * Always renders, even before the desktop has mirrored any usage window (an
 * older desktop build never writes `usage`, and a cold start hasn't probed yet),
 * because the Resume button has to stay reachable regardless. ActionBar hands
 * the home-indicator padding down to it for the same reason.
 */
export function UsageStrip({
  token,
  onResumed,
}: {
  token: string
  /** Arms the phone's auto-attach for the workspace a resumed session lands in. */
  onResumed?: (workspaceId: string | null) => void
}) {
  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | { usage?: unknown }
    | null
    | undefined

  return <UsageStripView chips={selectUsageChips(state?.usage)} token={token} onResumed={onResumed} />
}

/** Presentational half — split out so it can be rendered without a Convex client. */
export function UsageStripView({
  chips,
  token,
  onResumed,
}: {
  chips: UsageChip[]
  token?: string
  onResumed?: (workspaceId: string | null) => void
}) {
  const [resuming, setResuming] = useState(false)

  return (
    <>
      <div
        // The meters scroll horizontally: a scoped cap (e.g. a per-model weekly)
        // can push a provider past the phone's width, and clipping the number
        // that's about to block you is the worst outcome. Resume sits outside
        // that scroller so it stays put at the right edge.
        // usage-strip (globals.css): hidden while the soft keyboard is up.
        className="usage-strip pb-home-indicator flex items-center gap-2 border-t border-border bg-sidebar px-2 pt-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chips.map((chip) => (
            <div
              key={chip.id}
              title={chip.summary}
              aria-label={chip.summary}
              className="flex shrink-0 items-center gap-1.5"
              style={{ opacity: chip.stale ? 0.45 : 1 }}
            >
              <DynamicIcon name={chip.icon} size={11} className="shrink-0 opacity-60" />
              {chip.meters.map((meter) => (
                <Meter key={meter.key} meter={meter} />
              ))}
            </div>
          ))}
        </div>
        {token && (
          <button
            type="button"
            aria-label="Resume a session"
            // Keep the terminal focused so the device keyboard stays open.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setResuming(true)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground transition-colors active:bg-accent"
          >
            <ResumeGlyph size={11} />
            <span>Resume</span>
          </button>
        )}
      </div>
      {resuming && token && (
        <ResumeSheet
          token={token}
          onResumed={(workspaceId) => onResumed?.(workspaceId)}
          onClose={() => setResuming(false)}
        />
      )}
    </>
  )
}

function Meter({ meter }: { meter: UsageMeter }) {
  const color = levelColor(meter.level)
  return (
    <span className="flex shrink-0 items-center gap-1">
      {meter.inlineLabel && (
        <span className="font-mono text-[9px] uppercase leading-none text-muted-foreground">
          {meter.inlineLabel}
        </span>
      )}
      <span className="block h-1 w-6 overflow-hidden rounded-full bg-foreground/15">
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${meter.percent}%`, backgroundColor: color }}
        />
      </span>
      <span
        className="font-mono text-[10px] leading-none tabular-nums"
        // Only a window that's actually heading somewhere gets colored text;
        // a wall of green numbers would flatten the one signal that matters.
        style={{ color: meter.level === 'normal' ? undefined : color }}
      >
        {Math.round(meter.percent)}%
      </span>
    </span>
  )
}
