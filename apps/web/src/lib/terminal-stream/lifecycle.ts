import type { TerminalConnection } from './connection'

/** Keep activation separate from recovery after browser suspension. */
export function subscribeTerminalLifecycle(connection: () => TerminalConnection | null, onActivate: () => void): () => void {
  let wasHidden = document.visibilityState === 'hidden'
  const onFocusOrVisible = () => {
    const visible = document.visibilityState === 'visible'
    if (!visible) wasHidden = true
    else if (wasHidden) {
      wasHidden = false
      connection()?.resume()
    }
    connection()?.setActive(document.visibilityState === 'visible')
    if (document.visibilityState !== 'visible') return
    onActivate()
  }
  const onBlur = () => connection()?.setActive(false)
  const resumeStream = () => { if (document.visibilityState === 'visible') connection()?.resume() }
  // Convex dispatches synthetic online events to wake its own retry loop.
  // Those say nothing about this independent terminal transport.
  const onOnline = (event: Event) => { if (event.isTrusted) resumeStream() }
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) resumeStream() }
  window.addEventListener('blur', onBlur)
  window.addEventListener('online', onOnline)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('focus', onFocusOrVisible)
  document.addEventListener('visibilitychange', onFocusOrVisible)
  return () => {
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocusOrVisible)
    document.removeEventListener('visibilitychange', onFocusOrVisible)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('pageshow', onPageShow)
  }
}
