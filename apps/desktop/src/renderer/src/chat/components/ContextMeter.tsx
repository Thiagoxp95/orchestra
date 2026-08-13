
const RADIUS = 9.75
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Tiny ring gauge showing how much of the agent's context window is used.
 * Renders nothing until the mirror reports a ratio. Turns destructive-red
 * past 90% — the point where compaction is imminent.
 */
export function ContextMeter({ ratio }: { ratio: number | null }) {
  if (ratio == null) return null
  const clamped = Math.min(1, Math.max(0, ratio))
  const pct = Math.round(clamped * 100)
  return (
    <div
      className="flex size-5 shrink-0 items-center justify-center"
      title={`${pct}% of context used`}
    >
      <svg width={20} height={20} viewBox="0 0 24 24" className="-rotate-90">
        <circle
          cx={12}
          cy={12}
          r={RADIUS}
          fill="none"
          strokeWidth={3}
          style={{ stroke: 'color-mix(in srgb, var(--foreground) 12%, transparent)' }}
        />
        <circle
          cx={12}
          cy={12}
          r={RADIUS}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped)}
          style={{
            stroke: clamped > 0.9 ? 'var(--destructive)' : 'var(--primary)',
            transition: 'stroke-dashoffset 500ms ease-out, stroke 500ms ease-out',
          }}
        />
      </svg>
    </div>
  )
}
