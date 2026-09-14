'use client'
import { api, useQuery, useSync } from '../lib/sync'
import { useEffect, useRef, useState } from 'react'
import { Loader2, MonitorCog, MonitorDown, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
 * Hidden outright when the desktop mirrors no `updateStatus` at all — a button
 * that can't work is worse than no button.
 */
export function DesktopUpdateButton() {
  const sync = useSync()
  const state = useQuery(api.remote.getRemoteState) as
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
    void sync.call(api.remote.sendCommand, {
      sessionId: '',
      kind: 'restartToUpdate',
      payload: {},
    })
  }

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      disabled={view.disabled}
      aria-label={view.label}
      title={view.label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={send}
      className="size-7"
    >
      {view.icon === 'busy' ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : view.icon === 'error' ? (
        <TriangleAlert className="size-4 text-amber-500" />
      ) : view.icon === 'install' ? (
        <MonitorDown className="size-4 text-emerald-500" />
      ) : (
        <MonitorCog className="size-4 text-muted-foreground/60" />
      )}
    </Button>
  )
}
