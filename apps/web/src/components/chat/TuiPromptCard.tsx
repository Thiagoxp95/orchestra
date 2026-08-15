'use client'
import { memo } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TuiPrompt } from '../../lib/chat-messages'

/**
 * A TUI-native prompt (folder trust, tool permission) that the desktop scraped
 * off the terminal and mirrored — it has no transcript record, so this is the
 * only place it appears in chat. Rendered in the composer panel slot like the
 * question form: the agent is blocked on it, so it owns the composer until it's
 * answered. Tapping an option types that option's keys into the real TUI; the
 * card retires when the mirror stops reporting the prompt (the desktop clears it
 * once the prompt leaves the screen).
 *
 * memo behind primitive-ish props: ChatPane re-renders on every mirror push, and
 * a card rebuilt between touchstart and touchend drops the tap on iOS (same trap
 * the model picker documents).
 */
export const TuiPromptCard = memo(function TuiPromptCard({
  prompt,
  busy,
  onChoose,
}: {
  prompt: TuiPrompt
  /** An option's keys are in flight — freeze the buttons so a double-tap can't
   *  interleave two key sequences into the TUI. */
  busy: boolean
  onChoose: (optionIndex: number) => void
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-surface-raised/60 p-3">
      <div className="flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{prompt.title}</div>
          {prompt.detail && (
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{prompt.detail}</div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {prompt.options.map((opt, i) => (
          <button
            key={opt.label}
            type="button"
            // Keep the soft keyboard state as-is — this is a tap target, not a
            // text field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(i)}
            disabled={busy}
            className={cn(
              'flex h-10 w-full items-center justify-center rounded-full px-3 text-sm font-medium transition-colors disabled:opacity-40',
              opt.primary
                ? 'bg-primary text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.16)]'
                : 'border border-border/70 text-foreground active:bg-surface-hover',
              busy && 'animate-pulse',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
})
