'use client'
import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  isDrivableQuestionForm,
  type QuestionSelection,
  type QuestionSpec,
} from '../../lib/chat-messages'

// t3code's auto-advance beat: a single-select tap shows its check for a moment
// before the panel moves on (or submits, on the last question).
const AUTO_ADVANCE_MS = 200

/**
 * The live AskUserQuestion form, pinned inside the composer (t3code's
 * ComposerPendingUserInputPanel one-to-one): one question at a time with a
 * header chip and progress counter, options as tappable rows with digit
 * shortcuts, single-select auto-advances, multi-select toggles in place. The
 * form STATE lives in ChatPane (t3code keeps it in ChatView) so the composer
 * textarea can double as the custom-answer field and the footer can carry the
 * Previous / Next question / Submit answers cluster — this component only
 * renders the active question and reports taps.
 *
 * Underneath it still answers by typing the TUI key protocol from
 * chat-messages.ts — selections accumulate in the pane and one key sequence
 * drives the whole form at submit.
 */
export function ComposerQuestionPanel({
  questions,
  questionIndex,
  selections,
  busy,
  onToggleOption,
  onAdvance,
}: {
  questions: QuestionSpec[]
  questionIndex: number
  selections: QuestionSelection[]
  busy: boolean
  /** Toggle option `oi` on the active question; returns the next selections
   *  so the auto-advance can act on them before React re-renders. */
  onToggleOption: (oi: number) => QuestionSelection[]
  /** t3's onAdvance: next question, or submit when the last one completes. */
  onAdvance: (selections?: QuestionSelection[]) => void
}) {
  const drivable = isDrivableQuestionForm(questions)
  const qi = Math.max(0, Math.min(questionIndex, questions.length - 1))
  const q = questions[qi]
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const customAnswerActive = (selections[qi]?.customAnswer?.trim().length ?? 0) > 0

  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    },
    [],
  )

  const pickOption = (oi: number) => {
    if (busy || !q) return
    const next = onToggleOption(oi)
    if (q.multiSelect) return // multi-select toggles in place (t3code)
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null
      onAdvance(next)
    }, AUTO_ADVANCE_MS)
  }

  // Keyboard shortcut: digits 1-9 pick/toggle the matching option when focus
  // is outside an editable field (t3code parity — mostly desktop browsers).
  useEffect(() => {
    if (!drivable || busy) return
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return
      }
      const digit = Number.parseInt(event.key, 10)
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return
      const optionIndex = digit - 1
      if (!q || optionIndex >= q.options.length) return
      event.preventDefault()
      pickOption(optionIndex)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pickOption reads current state
  }, [drivable, busy, qi, q, selections])

  if (!q) return null

  return (
    <div className="-m-2 mb-0 rounded-t-[20px] border-b border-border/65 bg-foreground/[0.04] px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {q.header || 'Question'}
        </span>
        {questions.length > 1 && (
          <span className="flex h-5 items-center rounded-md bg-foreground/8 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {qi + 1}/{questions.length}
          </span>
        )}
      </div>

      <p className="text-sm text-foreground/90">{q.question}</p>
      {q.multiSelect && drivable ? (
        <p className="mt-1 text-xs text-muted-foreground">Select one or more options.</p>
      ) : null}
      {!drivable ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This form can&apos;t be answered from here — answer it on the desktop.
        </p>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {q.options.map((o, oi) => {
          const selected =
            !customAnswerActive && (selections[qi]?.optionIndexes.includes(oi) ?? false)
          const shortcutKey = oi < 9 ? oi + 1 : null
          return (
            <button
              key={`${qi}:${oi}`}
              type="button"
              disabled={!drivable || busy}
              onClick={() => pickOption(oi)}
              className={cn(
                'group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25',
                selected
                  ? 'border-primary/30 bg-primary/8 text-foreground'
                  : 'border-transparent bg-foreground/5 text-foreground/85 hover:border-border/45 hover:bg-foreground/10 active:bg-foreground/10',
                busy && 'opacity-50',
                !drivable && 'opacity-60',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                <span className="text-sm font-medium">{o.label}</span>
                {o.description && o.description !== o.label ? (
                  <span className="text-xs text-muted-foreground">{o.description}</span>
                ) : null}
              </span>
              {selected ? (
                <Check className="size-3.5 shrink-0 text-primary" strokeWidth={3} />
              ) : shortcutKey !== null && drivable ? (
                <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border/50 bg-foreground/5 text-[11px] font-medium tabular-nums text-muted-foreground transition-colors duration-150 group-hover:border-border/70 group-hover:text-foreground">
                  {shortcutKey}
                </kbd>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
