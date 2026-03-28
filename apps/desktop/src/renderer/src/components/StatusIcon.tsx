const STATUS_COLORS: Record<string, string> = {
  shaping: '#a855f7',
  todo: '#8b8b8b',
  in_progress: '#f59e0b',
  in_review: '#3b82f6',
  done: '#22c55e',
}

interface StatusIconProps {
  status: string
  size?: number
}

export function StatusIcon({ status, size = 14 }: StatusIconProps) {
  const color = STATUS_COLORS[status] ?? '#8b8b8b'
  const r = (size / 2) - 1.5
  const cx = size / 2
  const cy = size / 2

  // Shaping: dashed circle outline
  if (status === 'shaping') {
    const circumference = 2 * Math.PI * r
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={cx} cy={cy} r={r}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray={`${circumference / 8} ${circumference / 8}`}
        />
      </svg>
    )
  }

  // Todo: empty circle outline
  if (status === 'todo') {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    )
  }

  // In Progress: quarter fill (bottom-left arc filled)
  if (status === 'in_progress') {
    const circumference = 2 * Math.PI * r
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={`${color}30`} strokeWidth="1.5" />
        <circle
          cx={cx} cy={cy} r={r}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray={`${circumference * 0.5} ${circumference}`}
          strokeDashoffset={circumference * 0.25}
          strokeLinecap="round"
        />
      </svg>
    )
  }

  // In Review: three-quarter fill
  if (status === 'in_review') {
    const circumference = 2 * Math.PI * r
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={`${color}30`} strokeWidth="1.5" />
        <circle
          cx={cx} cy={cy} r={r}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray={`${circumference * 0.75} ${circumference}`}
          strokeDashoffset={circumference * 0.25}
          strokeLinecap="round"
        />
      </svg>
    )
  }

  // Done: filled circle with border
  if (status === 'done') {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill={color} stroke={color} strokeWidth="1.5" />
      </svg>
    )
  }

  // Fallback: solid dot
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill={color} />
    </svg>
  )
}
