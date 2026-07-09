import { useRef } from 'react'

const DAY_MIN = 24 * 60
const STEP_MIN = 15
const RED = '#ef4444'

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const toHHMM = (min: number): string => {
  const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * Two-thumb 00:00–24:00 slider. The red region between the thumbs is the blackout;
 * when start > end the red region wraps midnight (start→24:00 plus 00:00→end).
 */
export function BlackoutSlider({ value, onChange, txt, trackBg }: {
  value: { start: string; end: string }
  onChange: (v: { start: string; end: string }) => void
  txt: string
  trackBg: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const start = toMin(value.start)
  const end = toMin(value.end)
  const wraps = start > end
  const pct = (min: number) => (min / DAY_MIN) * 100

  const setThumb = (thumb: 'start' | 'end', rawMin: number) => {
    const snapped = (((Math.round(rawMin / STEP_MIN) * STEP_MIN) % DAY_MIN) + DAY_MIN) % DAY_MIN
    onChange(thumb === 'start' ? { ...value, start: toHHMM(snapped) } : { ...value, end: toHHMM(snapped) })
  }

  const beginDrag = (thumb: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      setThumb(thumb, Math.min(DAY_MIN - STEP_MIN, ratio * DAY_MIN))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    move(e.nativeEvent)
  }

  const onKey = (thumb: 'start' | 'end') => (e: React.KeyboardEvent) => {
    const delta =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -STEP_MIN
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? STEP_MIN
      : 0
    if (!delta) return
    e.preventDefault()
    setThumb(thumb, (thumb === 'start' ? start : end) + delta)
  }

  const thumbEl = (kind: 'start' | 'end', min: number) => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={kind === 'start' ? 'Blackout start' : 'Blackout end'}
      aria-valuemin={0}
      aria-valuemax={DAY_MIN - STEP_MIN}
      aria-valuenow={min}
      aria-valuetext={toHHMM(min)}
      onPointerDown={beginDrag(kind)}
      onKeyDown={onKey(kind)}
      className="absolute top-1/2 h-4 w-4 rounded-full cursor-grab focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ef4444] focus-visible:ring-offset-1"
      style={{
        left: `${pct(min)}%`,
        transform: 'translate(-50%, -50%)',
        backgroundColor: txt,
        border: `2px solid ${RED}`,
      }}
    />
  )

  const redSegment = (fromPct: number, toPct: number) => (
    <div
      className="absolute top-0 h-full rounded-full"
      style={{ left: `${fromPct}%`, width: `${toPct - fromPct}%`, backgroundColor: `${RED}99` }}
    />
  )

  return (
    <div className="px-1">
      <p className="mb-1 text-[10px] opacity-60" style={{ color: txt }}>
        No runs {value.start} – {value.end}{wraps ? ' (overnight)' : ''}
      </p>
      <div ref={trackRef} className="relative h-2 rounded-full" style={{ backgroundColor: trackBg }}>
        {wraps ? (
          <>
            {redSegment(pct(start), 100)}
            {redSegment(0, pct(end))}
          </>
        ) : (
          redSegment(pct(start), pct(end))
        )}
        {thumbEl('start', start)}
        {thumbEl('end', end)}
      </div>
      <div className="mt-1 flex justify-between text-[9px] opacity-40" style={{ color: txt }}>
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
      </div>
    </div>
  )
}
