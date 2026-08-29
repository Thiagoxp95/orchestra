'use client'
import { useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { Loader2, MonitorCog, MonitorDown, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Portal } from './Portal'
import { describeDesktopUpdate } from '@/lib/desktop-update'

/**
 * Restart the *desktop* to install its pending update, from the phone.
 *
 * Nothing to do with the UpdateButton beside it: that one force-refreshes this
 * PWA. This one reaches across to the Mac — the machine actually running the
 * agents — and is the only way to take a desktop update without walking over to
 * it.
 *
 * One command (`restartToUpdate`) covers both halves of the job, because from
 * here they are the same intent: with a build staged it restarts and installs,
 * and with nothing staged it checks, downloads, and leaves the install for the
 * next tap. The label always says which of those is about to happen — see
 * describeDesktopUpdate, where all of that judgement lives.
 *
 * Hidden outright when the desktop mirrors no `updateStatus` at all: the web
 * ships independently of the desktop build, so for a while after this lands the
 * phone is talking to a desktop that has never heard of the command, and a
 * button that can't work is worse than no button.
 *
 * The failed state gets special handling, because the amber triangle it flies is
 * the loudest thing in the header and used to be the least explicable: the
 * reason lived only in `title`, which a touch screen never shows. So a tap on
 * the warning opens the reason rather than blind-firing a retry, and the warning
 * can be dismissed once read — by message, so the next *different* failure still
 * gets your attention.
 */

const DISMISSED_KEY = 'orchestra.desktopUpdateErrorDismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    // Private-mode storage: the warning simply never stays dismissed.
    return null
  }
}

export function DesktopUpdateButton({ token, stale = false }: { token: string; stale?: boolean }) {
  const convex = useConvex()
  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | { updateStatus?: unknown }
    | null
    | undefined

  // Bridged optimism: sendCommand resolves as soon as the command is queued, so
  // the desktop's own `state` lags the tap by a beat. The nudge stands in for
  // that gap, and is spent the moment the status leaves its two resting phases —
  // derived rather than cleared by an effect, so the real status always wins the
  // render it arrives in.
  const [nudgedAt, setNudgedAt] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const raw = state?.updateStatus
  const phase = (raw as { state?: string } | undefined)?.state
  const pending = (raw as { restartPending?: boolean } | undefined)?.restartPending === true
  const resting = !pending && (!phase || phase === 'idle' || phase === 'not-available')
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])

  // Which failure the user has already read and waved off. Hydrated post-mount:
  // localStorage doesn't exist during SSR, and reading it on the first client
  // render would not match the server HTML.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissedKey(readDismissed())
  }, [])
  const [detailOpen, setDetailOpen] = useState(false)

  const view = describeDesktopUpdate(raw, { nudged: nudgedAt !== null && resting })
  // No updateStatus in the mirror: this desktop can't do it. Render nothing.
  if (!view) return null

  const send = () => {
    setNudgedAt(Date.now())
    if (timer.current) clearTimeout(timer.current)
    // Desktop offline, or the command went nowhere — fall back to the real
    // status rather than spinning forever.
    timer.current = setTimeout(() => setNudgedAt(null), 15_000)
    // Fire-and-forget, and safe to send twice: the desktop latches the restart.
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId: '',
      kind: 'restartToUpdate',
      payload: {},
    })
  }

  const failed = view.tone === 'error' && view.errorKey !== null
  const acknowledged = failed && view.errorKey === dismissedKey

  // With the desktop silent, every one of these states is a relic of the last
  // connection: the failure can't be retried (nothing is draining the command
  // table) and a staged install can't be taken. The connection banner is the
  // honest thing to look at then, so stand down to a muted icon rather than
  // flying an alarm about a machine that isn't there.
  const muted = stale || acknowledged

  const dismiss = () => {
    if (view.errorKey) {
      try {
        localStorage.setItem(DISMISSED_KEY, view.errorKey)
      } catch {
        // Private mode: it just comes back next render.
      }
      setDismissedKey(view.errorKey)
    }
    setDetailOpen(false)
  }

  const retry = () => {
    setDetailOpen(false)
    send()
  }

  const label = stale
    ? `${view.label} (from the last time your computer was connected)`
    : view.label

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        // Never disabled on a failure, even a stale one: the tap opens the
        // reason, and the reason is the whole point. The sheet's own "Try again"
        // is what goes dead while the desktop is silent.
        disabled={view.disabled}
        aria-label={label}
        title={label}
        onMouseDown={(e) => e.preventDefault()}
        // A failure is read before it is retried. Every other state is a single
        // intent, so it still fires on the first tap.
        onClick={failed ? () => setDetailOpen(true) : send}
        className="size-7"
      >
        {view.icon === 'busy' ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : view.icon === 'error' ? (
          <TriangleAlert className={muted ? 'size-4 text-muted-foreground/60' : 'size-4 text-amber-500'} />
        ) : view.icon === 'install' ? (
          <MonitorDown className={muted ? 'size-4 text-muted-foreground/60' : 'size-4 text-emerald-500'} />
        ) : (
          <MonitorCog className="size-4 text-muted-foreground/60" />
        )}
      </Button>
      {detailOpen && failed && (
        <UpdateErrorSheet
          detail={view.detail ?? ''}
          stale={stale}
          onRetry={retry}
          onDismiss={dismiss}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </>
  )
}

/**
 * The reason, as a bottom sheet — the same shape as every other phone-side
 * dialog here (see ConfirmSheet). A sheet rather than a strip under the header
 * because the connection banner already owns that slot, and these two warnings
 * are exactly the pair a user needs to be able to tell apart.
 */
function UpdateErrorSheet({
  detail,
  stale,
  onRetry,
  onDismiss,
  onClose,
}: {
  detail: string
  stale: boolean
  onRetry: () => void
  onDismiss: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
        <div
          onClick={(e) => e.stopPropagation()}
          role="alertdialog"
          aria-modal="true"
          aria-label="Desktop update failed"
          className="w-full rounded-t-2xl border border-border bg-sidebar p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-sm sm:rounded-2xl"
        >
          <div className="flex items-center gap-2 px-1 text-base font-medium text-foreground">
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
            Desktop update failed
          </div>
          <p className="mt-1.5 px-1 text-sm leading-snug break-words text-muted-foreground">{detail}</p>
          <p className="mt-2 px-1 text-xs leading-snug text-muted-foreground/80">
            {stale
              ? "This is the last thing your computer reported before it went quiet. Nothing can retry it until Orchestra is running there again — it doesn't affect the sessions you're reading."
              : "The auto-updater couldn't fetch a new build. It doesn't affect the sessions you're running — the desktop retries on its own every 30 minutes."}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm text-foreground transition-colors active:bg-accent"
            >
              Dismiss
            </button>
            <button
              type="button"
              autoFocus
              disabled={stale}
              onClick={onRetry}
              className="flex-1 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition-opacity active:opacity-80 disabled:opacity-40"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
