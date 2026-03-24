interface UsageBarProps {
  percent: number // 0-100
  label?: string
  size?: 'sm' | 'md'
  textColor: string
}

function barColor(percent: number): string {
  if (percent >= 80) return '#ef4444' // red
  if (percent >= 50) return '#eab308' // yellow
  return '#22c55e' // green
}

export function UsageBar({ percent, label, size = 'sm', textColor }: UsageBarProps) {
  const clamped = Math.max(0, Math.min(100, percent))
  const height = size === 'sm' ? 'h-1' : 'h-2'

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {label && (
        <span className="text-[10px] font-mono shrink-0 opacity-60" style={{ color: textColor }}>
          {label}
        </span>
      )}
      <div
        className={`flex-1 ${height} rounded-full overflow-hidden min-w-[32px]`}
        style={{ backgroundColor: `${textColor}15` }}
      >
        <div
          className={`${height} rounded-full transition-all duration-500`}
          style={{
            width: `${clamped}%`,
            backgroundColor: barColor(clamped),
          }}
        />
      </div>
      <span className="text-[10px] font-mono shrink-0" style={{ color: textColor }}>
        {Math.round(clamped)}%
      </span>
    </div>
  )
}
