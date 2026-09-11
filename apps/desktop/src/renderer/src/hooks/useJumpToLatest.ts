import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from 'xterm'

const api = window.electronAPI

// One wheel notch down, as an SGR mouse report (button 65). A full-screen TUI
// that negotiated mouse tracking reads this as "the wheel turned"; it is the
// same event a trackpad flick produces, so the program scrolls the way it
// already knows how.
const WHEEL_DOWN = '\x1b[<65;1;1M'

// Wheel deltas are pixels; this is roughly one notch's worth. Only the count
// matters — it decides how far the jump has to travel back.
const WHEEL_STEP_PX = 40
// A jump past the live end is harmless (the program clamps), so the burst runs
// a little long rather than stopping a screen short.
const JUMP_SLACK_NOTCHES = 12
const JUMP_MAX_NOTCHES = 240

/**
 * "Jump to latest" for a terminal pane: whether the reader has left the live end,
 * and the action that takes them back to it.
 *
 * Two buffers, two very different answers. On the normal buffer xterm owns the
 * scrollback, so its own scroll position is the truth and scrollToBottom is the
 * cure. On the alternate buffer the full-screen program owns its scroll and
 * reports nothing back — so the wheel notches that passed through on their way to
 * the PTY are the only record of where it was pushed, and undoing them is the
 * only way back. Without mouse tracking there is no safe scroll byte to send at
 * all (arrows would be read as navigation), so the pill stays down.
 */
export function useJumpToLatest(
  termRef: React.RefObject<Terminal | null>,
  sessionId: string,
): { showLatest: boolean; jumpToLatest: () => void } {
  const [showLatest, setShowLatest] = useState(false)
  const followBottomRef = useRef(true)
  const altBackRef = useRef(0)

  const sync = useCallback(() => {
    setShowLatest(!followBottomRef.current || altBackRef.current > 0)
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    followBottomRef.current = true
    altBackRef.current = 0
    setShowLatest(false)

    const onScroll = term.onScroll(() => {
      const b = term.buffer.active
      followBottomRef.current = b.viewportY >= b.baseY
      sync()
    })
    // A buffer swap discards whichever position we were reporting: the alt screen
    // is gone or brand new, and xterm is back at its own bottom.
    const onBuffer = term.buffer.onBufferChange(() => {
      altBackRef.current = 0
      followBottomRef.current = true
      sync()
    })

    let accum = 0
    const onWheel = (e: WheelEvent) => {
      if (term.buffer.active.type !== 'alternate') return
      if (term.modes.mouseTrackingMode === 'none') return
      accum -= e.deltaY // negative deltaY scrolls back through the transcript
      let notches = 0
      while (accum >= WHEEL_STEP_PX) {
        accum -= WHEEL_STEP_PX
        notches++
      }
      while (accum <= -WHEEL_STEP_PX) {
        accum += WHEEL_STEP_PX
        notches--
      }
      if (notches === 0) return
      altBackRef.current = Math.max(0, altBackRef.current + notches)
      sync()
    }
    const el = term.element
    el?.addEventListener('wheel', onWheel, { passive: true })

    return () => {
      onScroll.dispose()
      onBuffer.dispose()
      el?.removeEventListener('wheel', onWheel)
    }
    // termRef is stable; the terminal behind it is rebuilt per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sync])

  const jumpToLatest = useCallback(() => {
    const term = termRef.current
    if (!term) return
    if (term.buffer.active.type === 'alternate') {
      const back = altBackRef.current
      altBackRef.current = 0
      sync()
      if (term.modes.mouseTrackingMode === 'none' || back <= 0) return
      const count = Math.min(back + JUMP_SLACK_NOTCHES, JUMP_MAX_NOTCHES)
      api.writeTerminal(sessionId, WHEEL_DOWN.repeat(count))
      return
    }
    followBottomRef.current = true
    altBackRef.current = 0
    sync()
    term.scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sync])

  return { showLatest, jumpToLatest }
}
