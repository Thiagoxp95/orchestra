'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex } from 'convex/react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { BridgeStatus } from '../lib/bridge-liveness'
import { attemptReconnect, describeReconnectOutcome } from '../lib/reconnect'
import { cn } from '@/lib/utils'

/**
 * The link between this phone and the desktop, said out loud — and a button to
 * fix it.
 *
 * Two things were missing. First, the only connection surface the web had was a
 * banner that appears after 30s of silence, so at every other moment there was
 * no way to ask "when did my Mac last check in?" — the answer existed
 * (state.updatedAt) and was simply never rendered. The dot below is always in the
 * header and always carries the age, one tap from the full reading.
 *
 * Second, the banner was a dead end: it named a problem and offered nothing.
 * A phone roaming between Wi-Fi, cellular and a VPN drops the Convex websocket
 * routinely, and when it does the mirror freezes in a way that is indistinguishable
 * from the desktop having gone away — so the old copy ("Reopen Orchestra on your
 * computer") sent the user to the wrong machine about half the time. Reconnect
 * fixes the half that is fixable from here, and bridgeStatus/attemptReconnect
 * between them say which half it was.
 */

const DOT: Record<BridgeStatus['tone'], string> = {
  live: 'bg-emerald-500',
  offline: 'bg-amber-400',
  disconnected: 'bg-amber-400',
}

/** The header dot. Always mounted — this is the one status worth a fixed slot. */
export function ConnectionDot({
  status,
  open,
  onToggle,
}: {
  status: BridgeStatus
  open: boolean
  onToggle: () => void
}) {
  const label = status.lastSeen
    ? `${status.title} — desktop last seen ${status.lastSeen} ago`
    : status.title
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      className="flex size-7 shrink-0 items-center justify-center rounded-md transition-opacity active:opacity-60"
    >
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          DOT[status.tone],
          // A healthy link should read as background, not as a light to watch;
          // a broken one pulses until it is dealt with.
          status.tone === 'live' ? 'opacity-50' : 'animate-pulse',
        )}
      />
    </button>
  )
}

/**
 * The strip under the header. The caller opens it once the desktop has gone
 * quiet past BRIDGE_STALE_MS (the old banner's job — a websocket blip that
 * reconnects in under a second must not flash one), and on demand from the dot,
 * so "last seen" is reachable even when everything is fine.
 */
export function ConnectionPanel({
  status,
  updatedAt,
  onDismiss,
}: {
  status: BridgeStatus
  /** Read fresh inside the retry loop — a new push is the proof of life. */
  updatedAt: number | null | undefined
  onDismiss: () => void
}) {
  const convex = useConvex()
  const [retrying, setRetrying] = useState(false)
  // Tagged with the tone it was reported against, so a verdict is dropped the
  // moment the link changes state rather than sitting there contradicting the
  // headline above it. Derived at render — no effect to reset it.
  const [outcome, setOutcome] = useState<{ tone: BridgeStatus['tone']; text: string } | null>(null)

  // The loop polls for a push that arrives through React state, so it must read
  // the latest prop rather than the one captured when the tap fired. Mirrored in
  // an effect rather than assigned during render, which the compiler forbids.
  const latest = useRef(updatedAt)
  useEffect(() => {
    latest.current = updatedAt
  }, [updatedAt])

  // The tone the verdict is about — read when the loop settles, not when it
  // started, since settling is the moment the two are compared.
  const toneRef = useRef(status.tone)
  useEffect(() => {
    toneRef.current = status.tone
  }, [status.tone])

  // Alive-guard: the panel unmounts the moment the retry succeeds (its own
  // condition goes false), and settling state on the way out is a no-op warning.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const retry = useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    setOutcome(null)
    const result = await attemptReconnect({
      // The same public event useForegroundResync pokes: Convex's own network
      // listener turns it into an immediate reconnect, and going through the
      // event keeps this working across convex-client versions.
      poke: () => window.dispatchEvent(new Event('online')),
      isConnected: () => convex.connectionState().isWebSocketConnected,
      updatedAt: () => latest.current,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    if (!mounted.current) return
    setRetrying(false)
    setOutcome({ tone: toneRef.current, text: describeReconnectOutcome(result) })
  }, [convex, retrying])

  const broken = status.tone !== 'live'
  const verdict = outcome && outcome.tone === status.tone ? outcome.text : null

  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 text-xs',
        broken
          ? 'border-amber-900/60 bg-amber-950/40 text-amber-200'
          : 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[status.tone])} />
        <span className="min-w-0 flex-1 font-medium">
          {status.title}
          {status.lastSeen ? ` — last seen ${status.lastSeen} ago` : ''}
        </span>
        <button
          type="button"
          disabled={retrying}
          onClick={() => void retry()}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-medium transition-opacity active:opacity-60 disabled:opacity-50',
            broken ? 'border-amber-700/60' : 'border-border',
          )}
        >
          {retrying ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {retrying ? 'Reconnecting…' : 'Reconnect'}
        </button>
        {!status.stale && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Hide connection details"
            className="shrink-0 rounded-md px-1.5 py-1 opacity-70 transition-opacity active:opacity-40"
          >
            Close
          </button>
        )}
      </div>
      <p className="leading-snug opacity-90">{verdict ?? status.detail}</p>
    </div>
  )
}
