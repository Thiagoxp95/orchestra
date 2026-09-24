'use client'
import { useEffect, useRef } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { cn } from './cn'

/** Bars across the composer. 40 at 20Hz ≈ 2s of visible history. */
const BARS = 40
/** Advance the history every Nth frame; 3 ≈ 20Hz on a 60fps display. */
const FRAMES_PER_SAMPLE = 3
/** Shortest bar, so an idle mic still reads as a live meter rather than a gap. */
const FLOOR = 0.06

function mmss(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The composer-as-VU-meter: what the box turns into while the user holds it to
 * speak. Every frame it pulls the mic level straight from the dictation hook and
 * writes bar transforms through refs — no React state, because this repaints at
 * 60fps and the chat pane above it renders up to 400 rows.
 */
export function VoiceMeter({
  processing,
  getLevel,
}: {
  /** Mic is shut and the desktop is transcribing: freeze the bars, show a spinner. */
  processing: boolean
  getLevel: () => number
}) {
  const barsRef = useRef<Array<HTMLDivElement | null>>([])
  const timeRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (processing) return
    const startedAt = performance.now()
    const history = new Array<number>(BARS).fill(FLOOR)
    let frame = 0
    let raf = 0
    let shownSecond = -1

    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (frame++ % FRAMES_PER_SAMPLE !== 0) return
      history.shift()
      history.push(Math.max(FLOOR, getLevel()))
      for (let i = 0; i < BARS; i++) {
        const el = barsRef.current[i]
        if (el) el.style.transform = `scaleY(${history[i]})`
      }
      const elapsed = performance.now() - startedAt
      const second = Math.floor(elapsed / 1000)
      if (second !== shownSecond && timeRef.current) {
        shownSecond = second
        timeRef.current.textContent = mmss(elapsed)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getLevel, processing])

  return (
    <div
      // Not pointer-events-none: pointer events bubble from here up to the
      // composer card, which owns the press-and-hold gesture, so a release
      // anywhere over the meter still ends the utterance.
      className={cn(
        'absolute inset-0 z-10 flex select-none items-center gap-3 rounded-[22px] px-4',
        'bg-background/90 backdrop-blur-sm',
        processing ? 'text-muted-foreground' : 'text-destructive',
      )}
      role="status"
      aria-live="polite"
      aria-label={processing ? 'Transcribing' : 'Recording — release to stop'}
    >
      {processing ? (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      ) : (
        <Mic className="size-4 shrink-0 animate-pulse" />
      )}

      <div className="flex h-8 min-w-0 flex-1 items-center gap-[2px]">
        {Array.from({ length: BARS }, (_, i) => (
          <div
            key={i}
            ref={(el) => {
              barsRef.current[i] = el
            }}
            className={cn(
              'h-full min-w-0 flex-1 origin-center rounded-full',
              processing ? 'bg-muted-foreground/30' : 'bg-destructive/80',
            )}
            style={{ transform: `scaleY(${FLOOR})` }}
          />
        ))}
      </div>

      {processing ? (
        <span className="shrink-0 text-[11px]">Transcribing…</span>
      ) : (
        <span ref={timeRef} className="shrink-0 font-mono text-[11px] tabular-nums">
          0:00
        </span>
      )}
    </div>
  )
}
