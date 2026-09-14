'use client'
import { useState } from 'react'
import { Check, Loader2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The manual half of build freshness. useBuildFreshness (see build-freshness.ts)
 * reloads a stale page on foreground, but it is throttled, it only fires on a
 * visibility change, and it cannot help when the *service worker* is the stale
 * part — an installed PWA can hold an old SW whose fetch handler is what serves
 * the old document. This button is the escape hatch when the phone insists it's
 * current and clearly isn't: unregister nothing, but force the SW to re-fetch,
 * drop every Cache Storage entry, and hard-reload past the throttle.
 *
 * Deliberately unconditional — it does not check whether an update exists first.
 * The whole point is the case where the client's idea of "current" is wrong, so
 * asking the client is the one thing that can't be trusted.
 */
type State = 'idle' | 'working' | 'current'

export function UpdateButton() {
  const [state, setState] = useState<State>('idle')

  const forceUpdate = async (): Promise<void> => {
    if (state === 'working') return
    setState('working')
    const runningId = process.env.NEXT_PUBLIC_BUILD_ID
    let serverId: string | null = null
    try {
      const res = await fetch('/build-id.txt', { cache: 'no-store' })
      if (res.ok) serverId = (await res.text()).trim()
    } catch {
      // Offline: still worth clearing caches and reloading — the reload just
      // comes back off the cache, which is no worse than standing pat.
    }

    // Caches first: whatever the SW does next, the old bytes must not survive it.
    try {
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } catch {
      // Storage denied (private mode). The reload below still bypasses the
      // HTTP cache for the document via the SW's no-store navigation handler.
    }

    // Pull the newest worker script and hand the page to it. update() resolves
    // once the new SW is installed; skipWaiting (sw.js) makes it active without
    // waiting for this tab to close.
    try {
      const reg = await navigator.serviceWorker?.getRegistration()
      await reg?.update()
    } catch {
      // No SW (desktop browser, or registration failed) — the reload is enough.
    }

    // Already current AND nothing to re-fetch: say so instead of a reload that
    // looks identical to a no-op. Anything else reloads.
    if (serverId && runningId && serverId === runningId) {
      setState('current')
      setTimeout(() => setState('idle'), 2000)
      return
    }
    window.location.reload()
  }

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="Force update to the latest build"
      title="Force update"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void forceUpdate()}
      className="size-7"
    >
      {state === 'working' ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : state === 'current' ? (
        <Check className="size-4 text-emerald-500" />
      ) : (
        <RotateCw className="size-4 text-muted-foreground/60" />
      )}
    </Button>
  )
}
