'use client'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommand } from '@/lib/slash-commands'

/**
 * Autocomplete popover floating above the composer while a slash command is
 * being typed. Presentational — matching, highlight state, and the keyboard
 * protocol (arrows/Tab/Enter/Esc) live in ChatPane; this renders the rows and
 * reports taps. Positioned absolute so it never contributes to the measured
 * composer height (the timeline's bottom inset must not jump when it opens).
 */
export function SlashSuggestions({
  matches,
  highlightIndex,
  onPick,
}: {
  matches: SlashCommand[]
  highlightIndex: number
  onPick: (cmd: SlashCommand) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.children[highlightIndex]?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  return (
    <div
      ref={listRef}
      className="dropdown-glass surface-grain absolute inset-x-0 bottom-full z-20 mb-2 max-h-56 overflow-y-auto rounded-2xl border border-foreground/8 p-1.5"
    >
      {matches.map((c, i) => (
        <button
          key={c.name}
          type="button"
          // Keep the iOS keyboard up: preventing mousedown default stops the
          // textarea from blurring under the tap (same trick as the composer).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
          className={cn(
            'flex w-full items-baseline gap-2 rounded-lg px-2.5 py-2 text-left',
            i === highlightIndex ? 'bg-primary/12' : 'active:bg-surface-hover',
          )}
        >
          <span className="shrink-0 font-mono text-[13px] text-foreground">/{c.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {c.description}
          </span>
        </button>
      ))}
    </div>
  )
}
