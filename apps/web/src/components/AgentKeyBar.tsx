'use client'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Delete } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Modifiers } from '@/lib/keyboard'

type ModName = keyof Modifiers

interface AgentKeyBarProps {
  mods: Modifiers
  onToggleMod: (name: ModName) => void
  onSpecial: (key: string) => void
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

export function AgentKeyBar({ mods, onToggleMod, onSpecial }: AgentKeyBarProps) {
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
      </div>
    </div>
  )
}
