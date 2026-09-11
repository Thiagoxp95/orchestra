'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Delete, Keyboard, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Modifiers } from '@/lib/keyboard'
import { releaseHiddenKeyboardFocus } from '@/lib/viewport'
import { ImagePasteButton } from './ImagePasteButton'
import { TextPasteButton } from './TextPasteButton'

type ModName = keyof Modifiers

const KEY_BTN_CLASS = 'h-11 flex-1 min-w-0 px-0 text-xs font-medium tabular-nums'

/**
 * Every key in this bar cancels its press default so a tap mid-typing doesn't
 * blur the terminal and collapse an open keyboard. With the keyboard already
 * hidden that same preventDefault is what let Android throw the IME back over
 * the terminal: Chrome re-summons it for a still-focused editable on any touch,
 * and the terminal's helper textarea stays focused after the keyboard is
 * dismissed with the back gesture. Dropping that stale focus first — a no-op
 * while the keyboard is genuinely up — is the fix (see viewport.ts; the chat
 * composer's mic does the same).
 */
const pressWithoutKeyboard = (e: { preventDefault: () => void }) => {
  e.preventDefault()
  releaseHiddenKeyboardFocus()
}

/** Hold Backspace this long to switch from character deletes to line deletes. */
const LINE_DELETE_HOLD_MS = 2000
/** Once in line mode, keep killing lines at this cadence while still held. */
const LINE_DELETE_REPEAT_MS = 400

interface AgentKeyBarProps {
  token: string
  sessionId: string
  mods: Modifiers
  onToggleMod: (name: ModName) => void
  onSpecial: (key: string) => void
  isDictating: boolean
  isDictationProcessing: boolean
  onDictateStart: () => void
  onDictateStop: () => void
  onKeyboard: () => void
}

function KeyBtn({
  children,
  onClick,
  active,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
  'aria-label'?: string
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-label={ariaLabel}
      aria-pressed={active}
      // Keep an open keyboard open (mousedown), but let go of a keyboard that is
      // already hidden (pointerdown) — see pressWithoutKeyboard. Not cancelled on
      // pointerdown: these keys act on `click`, and this bar is the one input
      // surface in terminal mode.
      onPointerDown={() => releaseHiddenKeyboardFocus()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(KEY_BTN_CLASS)}
    >
      {children}
    </Button>
  )
}

/**
 * Backspace with a press-and-hold escalation, mirroring the Mac: a tap deletes
 * one character, but holding past LINE_DELETE_HOLD_MS behaves like
 * Cmd+Backspace and deletes whole lines (repeating until release).
 */
function BackspaceBtn({ onSpecial }: { onSpecial: (key: string) => void }) {
  const [lineMode, setLineMode] = useState(false)
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Unconditional: safe to call on every pointer-up/leave/cancel, and on a
  // re-press that never saw its matching release.
  const stop = useCallback(() => {
    if (holdRef.current) {
      clearTimeout(holdRef.current)
      holdRef.current = null
    }
    if (repeatRef.current) {
      clearInterval(repeatRef.current)
      repeatRef.current = null
    }
    setLineMode(false)
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(() => {
    stop()
    // One character immediately so a plain tap still feels instant.
    onSpecial('backspace')
    holdRef.current = setTimeout(() => {
      setLineMode(true)
      // Android only — iOS Safari has no vibrate, so the button's filled state
      // is the primary cue that the key flipped to line mode.
      navigator.vibrate?.(20)
      onSpecial('deleteline')
      repeatRef.current = setInterval(() => onSpecial('deleteline'), LINE_DELETE_REPEAT_MS)
    }, LINE_DELETE_HOLD_MS)
  }, [onSpecial, stop])

  return (
    <Button
      type="button"
      size="sm"
      variant={lineMode ? 'default' : 'outline'}
      aria-label={lineMode ? 'Delete line' : 'Backspace'}
      onMouseDown={(e) => e.preventDefault()}
      // Long-press must not open the context menu / text-selection callout.
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        pressWithoutKeyboard(e)
        start()
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      className={cn(KEY_BTN_CLASS, 'select-none touch-none')}
    >
      <Delete className="size-4" />
    </Button>
  )
}

export function AgentKeyBar({
  token,
  sessionId,
  mods,
  onToggleMod,
  onSpecial,
  isDictating,
  isDictationProcessing,
  onDictateStart,
  onDictateStop,
  onKeyboard,
}: AgentKeyBarProps) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-sidebar p-1.5">
      <div className="flex gap-1.5">
        <KeyBtn onClick={() => onSpecial('esc')}>Esc</KeyBtn>
        <KeyBtn onClick={() => onSpecial('tab')}>Tab</KeyBtn>
        <KeyBtn active={mods.ctrl} onClick={() => onToggleMod('ctrl')}>
          Ctrl
        </KeyBtn>
        <KeyBtn aria-label="Up" onClick={() => onSpecial('up')}>
          <ArrowUp className="size-4" />
        </KeyBtn>
        <KeyBtn active={mods.shift} onClick={() => onToggleMod('shift')}>
          Shift
        </KeyBtn>
        <BackspaceBtn onSpecial={onSpecial} />
        <ImagePasteButton token={token} sessionId={sessionId} />
      </div>
      <div className="flex gap-1.5">
        <KeyBtn active={mods.alt} onClick={() => onToggleMod('alt')}>
          Alt
        </KeyBtn>
        <KeyBtn onClick={() => onSpecial('space')}>Space</KeyBtn>
        <KeyBtn aria-label="Left" onClick={() => onSpecial('left')}>
          <ArrowLeft className="size-4" />
        </KeyBtn>
        <KeyBtn aria-label="Down" onClick={() => onSpecial('down')}>
          <ArrowDown className="size-4" />
        </KeyBtn>
        <KeyBtn aria-label="Right" onClick={() => onSpecial('right')}>
          <ArrowRight className="size-4" />
        </KeyBtn>
        <KeyBtn onClick={() => onSpecial('enter')}>Enter</KeyBtn>
        <TextPasteButton token={token} sessionId={sessionId} />
      </div>
      {/* Hold-to-talk: full-width row under the key rows. Hold → record on the
          phone → the desktop transcribes with Parakeet and types it into the
          agent's input (no Enter — the user reviews and submits). */}
      <div className="flex gap-1.5">
      <Button
        type="button"
        aria-label="Hold to talk"
        aria-pressed={isDictating}
        disabled={isDictationProcessing}
        onMouseDown={(e) => e.preventDefault()}
        // Long-press must not open the context menu / text-selection callout.
        onContextMenu={(e) => e.preventDefault()}
        // Press-and-hold via pointer events: down = record, up/leave/cancel = stop.
        // stop() is unconditional: it decides internally whether there is an
        // utterance to end, because this component's `isDictating` can still be
        // false on a fast tap (the state update has not committed yet) and
        // gating on it here used to leave the mic open until the 60s cap.
        onPointerDown={(e) => {
          pressWithoutKeyboard(e)
          onDictateStart()
        }}
        onPointerUp={onDictateStop}
        onPointerLeave={onDictateStop}
        onPointerCancel={onDictateStop}
        className={cn(
          'h-11 min-w-0 flex-1 select-none touch-none text-sm font-semibold text-white',
          'bg-red-600 hover:bg-red-600 active:bg-red-700',
          isDictating && 'animate-pulse bg-red-700',
          isDictationProcessing && 'bg-red-900 opacity-80',
        )}
      >
        <Mic className="size-4" />
        {isDictationProcessing ? 'Transcribing…' : isDictating ? 'Listening…' : 'Hold to talk'}
      </Button>
      <Button type="button" variant="outline" aria-label="Open terminal keyboard" onClick={onKeyboard}
        className="size-11 shrink-0">
        <Keyboard className="size-5" />
      </Button>
      </div>
    </div>
  )
}
