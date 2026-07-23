'use client'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Delete, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Modifiers } from '@/lib/keyboard'
import { ImagePasteButton } from './ImagePasteButton'
import { TextPasteButton } from './TextPasteButton'

type ModName = keyof Modifiers

interface AgentKeyBarProps {
  token: string
  sessionId: string
  mods: Modifiers
  onToggleMod: (name: ModName) => void
  onSpecial: (key: string) => void
  isDictating: boolean
  onDictateStart: () => void
  onDictateStop: () => void
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
      // Keep the terminal focused so the device keyboard stays open.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('h-9 flex-1 min-w-0 px-0 text-xs font-medium tabular-nums')}
    >
      {children}
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
  onDictateStart,
  onDictateStop,
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
        <KeyBtn aria-label="Backspace" onClick={() => onSpecial('backspace')}>
          <Delete className="size-4" />
        </KeyBtn>
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
          phone → the desktop transcribes with Parakeet and submits it (Enter). */}
      <Button
        type="button"
        aria-label="Hold to talk"
        aria-pressed={isDictating}
        // Keep the terminal focused so the device keyboard stays open.
        onMouseDown={(e) => e.preventDefault()}
        // Long-press must not open the context menu / text-selection callout.
        onContextMenu={(e) => e.preventDefault()}
        // Press-and-hold via pointer events: down = record, up/leave/cancel = stop.
        onPointerDown={(e) => {
          e.preventDefault()
          onDictateStart()
        }}
        onPointerUp={onDictateStop}
        onPointerLeave={() => {
          if (isDictating) onDictateStop()
        }}
        onPointerCancel={onDictateStop}
        className={cn(
          'h-11 w-full select-none touch-none text-sm font-semibold text-white',
          'bg-red-600 hover:bg-red-600 active:bg-red-700',
          isDictating && 'animate-pulse bg-red-700',
        )}
      >
        <Mic className="size-4" />
        {isDictating ? 'Listening…' : 'Hold to talk'}
      </Button>
    </div>
  )
}
