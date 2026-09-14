'use client'
import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Delete, Keyboard, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Modifiers } from '@/lib/keyboard'
import { createKeyRepeat } from '@/lib/key-repeat'
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

interface AgentKeyBarProps {
  sessionId: string
  mods: Modifiers
  onToggleMod: (name: ModName) => void
  onModDown: (name: ModName, pointerId: number) => void
  onModUp: (pointerId: number, cancelled?: boolean) => void
  onSpecial: (key: string) => void
  isDictating: boolean
  isDictationProcessing: boolean
  onDictateStart: () => void
  onDictateStop: () => void
  getInputLease?: () => string | undefined
  canSend?: () => boolean
  onPaste?: (data: string) => boolean
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
      // Act on pointerdown: a second touch may not generate a compatibility click.
      onPointerDown={(e) => {
        if (e.button !== 0 || e.currentTarget.matches(':disabled')) return
        pressWithoutKeyboard(e)
        onClick()
      }}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (e.detail === 0) onClick() }}
      className={cn(KEY_BTN_CLASS, 'select-none touch-none')}
    >
      {children}
    </Button>
  )
}

function ModifierBtn({ name, label, children, active, onToggleMod, onModDown, onModUp }: {
  name: ModName
  label: string
  children: React.ReactNode
  active: boolean
} & Pick<AgentKeyBarProps, 'onToggleMod' | 'onModDown' | 'onModUp'>) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-label={label}
      aria-pressed={active}
      title={`${label}: hold to combine, or tap for the next key`}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.currentTarget.matches(':disabled')) return
        pressWithoutKeyboard(e)
        e.currentTarget.setPointerCapture(e.pointerId)
        onModDown(name, e.pointerId)
      }}
      onPointerUp={(e) => onModUp(e.pointerId)}
      onPointerCancel={(e) => onModUp(e.pointerId, true)}
      onLostPointerCapture={(e) => onModUp(e.pointerId, true)}
      onClick={(e) => { if (e.detail === 0) onToggleMod(name) }}
      className={cn(KEY_BTN_CLASS, 'select-none touch-none', active && 'ring-1 ring-inset ring-primary')}
    >
      {children}
    </Button>
  )
}

/** A held key repeats characters and stops on release, cancellation, or blur. */
function BackspaceBtn({ onSpecial }: { onSpecial: (key: string) => void }) {
  const onSpecialRef = useRef(onSpecial)
  onSpecialRef.current = onSpecial
  const repeatRef = useRef<ReturnType<typeof createKeyRepeat> | null>(null)
  if (!repeatRef.current) {
    repeatRef.current = createKeyRepeat(() => onSpecialRef.current('backspace'))
  }
  const repeat = repeatRef.current

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) repeat.stop() }
    window.addEventListener('blur', repeat.stop)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      repeat.stop()
      window.removeEventListener('blur', repeat.stop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [repeat])

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label="Backspace"
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.currentTarget.matches(':disabled')) return
        pressWithoutKeyboard(e)
        repeat.start()
      }}
      onPointerUp={repeat.stop}
      onPointerLeave={repeat.stop}
      onPointerCancel={repeat.stop}
      onLostPointerCapture={repeat.stop}
      onBlur={repeat.stop}
      // Keyboard and assistive-technology activation has no pointerdown.
      onClick={(e) => { if (e.detail === 0) onSpecialRef.current('backspace') }}
      className={cn(KEY_BTN_CLASS, 'select-none touch-none')}
    >
      <Delete className="size-4" />
    </Button>
  )
}

export function AgentKeyBar({
  sessionId,
  mods,
  onToggleMod,
  onModDown,
  onModUp,
  onSpecial,
  isDictating,
  isDictationProcessing,
  onDictateStart,
  onDictateStop,
  onKeyboard,
  onPaste,
  canSend,
  getInputLease,
}: AgentKeyBarProps) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-sidebar p-1.5">
      <div className="flex gap-1.5">
        <KeyBtn onClick={() => onSpecial('esc')}>Esc</KeyBtn>
        <KeyBtn onClick={() => onSpecial('tab')}>Tab</KeyBtn>
        <KeyBtn onClick={() => onSpecial('space')}>Space</KeyBtn>
        <KeyBtn aria-label="Up" onClick={() => onSpecial('up')}>
          <ArrowUp className="size-4" />
        </KeyBtn>
        <BackspaceBtn key={sessionId} onSpecial={onSpecial} />
        <ImagePasteButton sessionId={sessionId} canSend={canSend} getInputLease={getInputLease} />
      </div>
      <div className="flex gap-1.5">
        <KeyBtn aria-label="Open terminal keyboard" onClick={onKeyboard}>
          <Keyboard className="size-4" />
        </KeyBtn>
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
        <TextPasteButton sessionId={sessionId} onPaste={onPaste} />
      </div>
      {/* Mac modifiers and hold-to-talk share the bottom row equally. */}
      <div className="flex gap-1.5">
        {([
          ['ctrl', 'Control', '⌃ Ctrl'],
          ['shift', 'Shift', '⇧ Shift'],
          ['alt', 'Option', '⌥ Opt'],
          ['meta', 'Command', '⌘ Cmd'],
        ] as const).map(([name, label, text]) => (
          <ModifierBtn key={name} name={name} label={label} active={mods[name]}
            onToggleMod={onToggleMod} onModDown={onModDown} onModUp={onModUp}>
            {text}
          </ModifierBtn>
        ))}
        <Button
          type="button"
          size="sm"
          aria-label="Hold to talk"
          aria-pressed={isDictating}
          title={isDictationProcessing ? 'Transcribing…' : isDictating ? 'Listening…' : 'Hold to talk'}
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
          onClick={(e) => {
            if (e.detail === 0) {
              if (isDictating) onDictateStop()
              else onDictateStart()
            }
          }}
          className={cn(
            KEY_BTN_CLASS,
            'select-none touch-none p-0 text-white',
            'bg-red-600 hover:bg-red-600 active:bg-red-700',
            isDictating && 'animate-pulse bg-red-700',
            isDictationProcessing && 'bg-red-900 opacity-80',
          )}
        >
          <Mic aria-hidden="true" className="size-5" />
        </Button>
      </div>
    </div>
  )
}
