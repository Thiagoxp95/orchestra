'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  buildQuestionKeySequence,
  isDrivableQuestionForm,
  type DisplayBlock,
  type KeyStep,
  type QuestionSelection,
} from '../../lib/chat-messages'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

// If the transcript's answer never comes back (keys lost, form gone), unfreeze
// the panel so the user can retry instead of staring at a dead "Submitting…".
const SUBMIT_STUCK_MS = 15_000

// t3code's auto-advance beat: a single-select tap shows its check for a moment
// before the panel moves on (or submits, on the last question).
const AUTO_ADVANCE_MS = 200

/**
 * The live AskUserQuestion form, pinned inside the composer (t3code's
 * ComposerPendingUserInputPanel one-to-one): one question at a time with a
 * header chip and progress counter, options as tappable rows with digit
 * shortcuts, single-select auto-advances, and the footer walks
 * Previous / Next question / Submit answers. Underneath it still answers by
 * typing the TUI key protocol from chat-messages.ts — selections accumulate
 * locally and one key sequence drives the whole form at submit.
 *
 * Pinning it here (instead of an interactive card lost in the timeline) is
 * the fix for "missed the questionnaire": the form sits on top of the input
 * you're already looking at, and the Submitting state lives where you tapped.
 */
export function ComposerQuestionPanel({
  block,
  onSendKeys,
}: {
  block: QuestionBlock
  /** Paced writes into the session's PTY (the pane owns the Convex plumbing). */
  onSendKeys: (steps: KeyStep[]) => Promise<void>
}) {
  const { questions } = block

  const [questionIndex, setQuestionIndex] = useState(0)
  const [selections, setSelections] = useState<QuestionSelection[]>(() =>
    questions.map(() => ({ optionIndexes: [] })),
  )
  const [busy, setBusy] = useState<'submit' | 'dismiss' | null>(null)
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (stuckTimer.current) clearTimeout(stuckTimer.current)
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    },
    [],
  )

  const drivable = isDrivableQuestionForm(questions)
  const qi = Math.max(0, Math.min(questionIndex, questions.length - 1))
  const q = questions[qi]
  const isLast = qi >= questions.length - 1
  const canAdvance = selections[qi]?.optionIndexes.length === 1
  const complete = useMemo(
    () => selections.every((s) => s.optionIndexes.length === 1),
    [selections],
  )

  const run = (kind: 'submit' | 'dismiss', keys: KeyStep[]) => {
    setBusy(kind)
    if (stuckTimer.current) clearTimeout(stuckTimer.current)
    stuckTimer.current = setTimeout(() => setBusy(null), SUBMIT_STUCK_MS)
    void onSendKeys(keys).catch(() => setBusy(null))
  }

  const submit = (sel: QuestionSelection[]) => {
    const steps = buildQuestionKeySequence(questions, sel)
    if (steps) run('submit', steps)
  }

  // t3's onAdvance: on the last question a complete form submits; otherwise
  // move to the next question.
  const advance = (sel: QuestionSelection[]) => {
    if (isLast) {
      if (sel.every((s) => s.optionIndexes.length === 1)) submit(sel)
      return
    }
    setQuestionIndex(qi + 1)
  }

  const pickOption = (oi: number) => {
    if (busy !== null) return
    const next = selections.map((s, i) => (i === qi ? { optionIndexes: [oi] } : s))
    setSelections(next)
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null
      advance(next)
    }, AUTO_ADVANCE_MS)
  }

  // Keyboard shortcut: digits 1-9 pick the matching option when focus is
  // outside an editable field (t3code parity — mostly for desktop browsers).
  useEffect(() => {
    if (!drivable || busy !== null) return
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

  const primaryLabel =
    busy === 'submit'
      ? 'Submitting…'
      : !isLast
        ? 'Next question'
        : questions.length > 1
          ? 'Submit answers'
          : 'Submit answer'

  return (
    <div className="border-b border-border/50 px-2 pb-2.5 pt-1">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {q.header || 'Question'}
        </span>
        {questions.length > 1 && (
          <span className="flex h-5 items-center rounded-md bg-foreground/8 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {qi + 1}/{questions.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => run('dismiss', [{ data: '\x1b', delayAfterMs: 0 }])}
          disabled={busy !== null}
          aria-label="Dismiss questions"
          className="ml-auto flex size-6 items-center justify-center rounded-full text-muted-foreground active:bg-foreground/10 disabled:opacity-40"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <p className="text-sm text-foreground/90">{q.question}</p>
      {!drivable ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Multi-select — answer this one on the desktop.
        </p>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {q.options.map((o, oi) => {
          const selected = selections[qi]?.optionIndexes.includes(oi) ?? false
          const shortcutKey = oi < 9 ? oi + 1 : null
          return (
            <button
              key={`${qi}:${oi}`}
              type="button"
              disabled={!drivable || busy !== null}
              onClick={() => pickOption(oi)}
              className={cn(
                'group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150',
                selected
                  ? 'border-primary/30 bg-primary/10 text-foreground'
                  : 'border-transparent bg-foreground/5 text-foreground/85 active:bg-foreground/10',
                busy !== null && 'opacity-50',
                !drivable && 'opacity-60',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{o.label}</span>
                {o.description && o.description !== o.label ? (
                  <span className="text-xs text-muted-foreground">{o.description}</span>
                ) : null}
              </span>
              {selected ? (
                <Check className="size-3.5 shrink-0 text-primary" strokeWidth={3} />
              ) : shortcutKey !== null && drivable ? (
                <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border/50 bg-foreground/5 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {shortcutKey}
                </kbd>
              ) : null}
            </button>
          )
        })}
      </div>

      {drivable && (
        <div className="mt-2.5 flex items-center justify-end gap-2">
          {qi > 0 && (
            <button
              type="button"
              onClick={() => setQuestionIndex(qi - 1)}
              disabled={busy !== null}
              className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground active:bg-foreground/10 disabled:opacity-40"
            >
              Previous
            </button>
          )}
          <button
            type="button"
            onClick={() => advance(selections)}
            disabled={busy !== null || (isLast ? !complete : !canAdvance)}
            className={cn(
              'rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-40',
              busy === 'submit' && 'animate-pulse',
            )}
          >
            {primaryLabel}
          </button>
        </div>
      )}
    </div>
  )
}
