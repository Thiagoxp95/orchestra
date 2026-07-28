'use client'
import { useMemo, useRef, useState } from 'react'
import { Check, CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  buildQuestionKeySequence,
  type DisplayBlock,
  type KeyStep,
  type QuestionSelection,
  type QuestionSpec,
} from '../lib/chat-messages'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

// If the transcript's answer never comes back (keys lost, form gone), unfreeze
// the card so the user can retry instead of staring at a dead "Answering…".
const SUBMIT_STUCK_MS = 15_000

/**
 * An AskUserQuestion form rendered as a chat card. While the form is the
 * conversation's live tail it is interactive: options are tappable, Submit
 * drives the real desktop TUI via the key protocol in chat-messages.ts, and
 * the answered state arrives back through the transcript mirror like any tool
 * result. Historical forms render as a static record of what was asked and
 * chosen.
 *
 * Same surface rules as the rest of the pane: foreground-alpha overlays only,
 * so every workspace tint stays legible.
 */
export function QuestionCard({
  block,
  interactive,
  onSendKeys,
}: {
  block: QuestionBlock
  /** The form is pending AND is the conversation's live tail. */
  interactive: boolean
  /** Paced writes into the session's PTY (the pane owns the Convex plumbing). */
  onSendKeys: (steps: KeyStep[]) => Promise<void>
}) {
  const { questions, result } = block

  const [selections, setSelections] = useState<QuestionSelection[]>(() =>
    questions.map(() => ({ optionIndexes: [] })),
  )
  const [busy, setBusy] = useState<'submit' | 'dismiss' | null>(null)
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const steps = useMemo(
    () => buildQuestionKeySequence(questions, selections),
    [questions, selections],
  )

  const tapOption = (qi: number, oi: number) => {
    setSelections((prev) =>
      prev.map((sel, i) => {
        if (i !== qi) return sel
        if (questions[qi].multiSelect) {
          const has = sel.optionIndexes.includes(oi)
          const optionIndexes = has
            ? sel.optionIndexes.filter((x) => x !== oi)
            : [...sel.optionIndexes, oi].sort((a, b) => a - b)
          return { ...sel, optionIndexes }
        }
        // Picking an option clears a typed "other" answer and vice versa —
        // the TUI records exactly one of the two per single-select question.
        return { optionIndexes: [oi] }
      }),
    )
  }

  const setOther = (qi: number, text: string) => {
    setSelections((prev) =>
      prev.map((sel, i) => (i === qi ? { optionIndexes: [], otherText: text } : sel)),
    )
  }

  const run = (kind: 'submit' | 'dismiss', keys: KeyStep[]) => {
    setBusy(kind)
    if (stuckTimer.current) clearTimeout(stuckTimer.current)
    stuckTimer.current = setTimeout(() => setBusy(null), SUBMIT_STUCK_MS)
    void onSendKeys(keys).catch(() => setBusy(null))
  }

  // ── Static states ─────────────────────────────────────────────────────────
  if (result) return <SettledCard questions={questions} result={result} />
  if (!interactive) {
    return (
      <CardShell footer="No longer active">
        {questions.map((q, qi) => (
          <div key={qi}>
            <QuestionHeading q={q} />
            <div className="mt-1.5 space-y-1">
              {q.options.map((o, oi) => (
                <div key={oi} className="rounded-lg border border-border/60 px-3 py-1.5 opacity-60">
                  <div className="text-sm text-foreground">{o.label}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardShell>
    )
  }

  // ── The live form ─────────────────────────────────────────────────────────
  return (
    <CardShell live>
      {questions.map((q, qi) => {
        const sel = selections[qi]
        const other = sel.otherText ?? ''
        return (
          <div key={qi}>
            <QuestionHeading q={q} />
            <div className="mt-1.5 space-y-1.5">
              {q.options.map((o, oi) => {
                const selected = sel.optionIndexes.includes(oi)
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => tapOption(qi, oi)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                      selected
                        ? 'border-foreground/60 bg-foreground/15'
                        : 'border-border bg-foreground/5 active:bg-foreground/10',
                      busy !== null && 'opacity-60',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                        q.multiSelect ? 'rounded' : 'rounded-full',
                        selected ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/60',
                      )}
                    >
                      {selected && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-snug text-foreground">{o.label}</span>
                      {o.description && (
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                          {o.description}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
              {/* The TUI's "Type something." — single-select only: the key
                  protocol for a custom answer on a multi-select tab is
                  unverified, so the phone doesn't offer it there. */}
              {!q.multiSelect && (
                <textarea
                  rows={1}
                  value={other}
                  disabled={busy !== null}
                  onChange={(e) => setOther(qi, e.target.value)}
                  placeholder="Type something…"
                  // 16px is load-bearing on iOS — see the composer's note.
                  className={cn(
                    'w-full resize-none rounded-lg border bg-foreground/5 px-3 py-2 text-[16px] leading-5 text-foreground outline-none placeholder:text-muted-foreground',
                    other.trim() ? 'border-foreground/60 bg-foreground/15' : 'border-border',
                  )}
                />
              )}
            </div>
          </div>
        )
      })}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={steps === null || busy !== null}
          onClick={() => steps && run('submit', steps)}
          className={cn(
            'flex-1 rounded-lg bg-foreground py-2 text-sm font-semibold text-background disabled:opacity-40',
            busy === 'submit' && 'animate-pulse',
          )}
        >
          {busy === 'submit' ? 'Answering…' : 'Submit'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => run('dismiss', [{ data: '\x1b', delayAfterMs: 0 }])}
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground active:bg-foreground/10 disabled:opacity-40"
        >
          {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>
    </CardShell>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function CardShell({
  children,
  footer,
  live,
}: {
  children: React.ReactNode
  footer?: string
  live?: boolean
}) {
  return (
    <div className="rounded-xl border border-border bg-foreground/5 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CircleHelp className="size-3.5" />
        Claude is asking
        {live && <span className="ml-auto size-1.5 animate-pulse rounded-full bg-foreground/70" />}
      </div>
      <div className="space-y-3">{children}</div>
      {footer && <div className="mt-2 text-[11px] text-muted-foreground">{footer}</div>}
    </div>
  )
}

function QuestionHeading({ q }: { q: QuestionSpec }) {
  return (
    <div>
      {q.header && (
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {q.header}
          {q.multiSelect && <span className="font-normal normal-case tracking-normal"> · pick any</span>}
        </div>
      )}
      <div className="mt-0.5 text-sm font-medium leading-snug text-foreground">{q.question}</div>
    </div>
  )
}

/** The historical record: what was asked, what was chosen (or that it was dismissed). */
function SettledCard({
  questions,
  result,
}: {
  questions: QuestionSpec[]
  result: NonNullable<QuestionBlock['result']>
}) {
  const dismissed = result.isError === true
  return (
    <CardShell footer={dismissed ? 'Dismissed — answered in chat instead' : undefined}>
      {questions.map((q, qi) => {
        const answer = result.answers?.[q.question]
        return (
          <div key={qi}>
            <QuestionHeading q={q} />
            {!dismissed && (
              <div className="mt-1 flex items-start gap-1.5 text-sm text-foreground">
                <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={3} />
                <span className="min-w-0 break-words">{answer ?? 'Answered'}</span>
              </div>
            )}
          </div>
        )
      })}
    </CardShell>
  )
}
