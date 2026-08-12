'use client'
import { Check, CircleHelp } from 'lucide-react'
import { type DisplayBlock, type QuestionSpec } from '../lib/chat-messages'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

/**
 * An AskUserQuestion form's timeline record. Interaction happens in the
 * composer's pinned panel (ComposerQuestionPanel, t3code style) — this card is
 * the history: while the form is live it points at the composer; once the
 * result arrives it shows what was asked and what was chosen, so an answered
 * form never reads as a dead "submitted" with no feedback.
 *
 * Same surface rules as the rest of the pane: foreground-alpha overlays only,
 * so every workspace tint stays legible.
 */
export function QuestionCard({
  block,
  live,
}: {
  block: QuestionBlock
  /** The form is pending AND is the conversation's live tail. */
  live: boolean
}) {
  const { questions, result } = block
  if (result) return <SettledCard questions={questions} result={result} />

  return (
    <CardShell live={live} footer={live ? 'Answer in the composer below' : 'No longer active'}>
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
    <div className="rounded-2xl border border-border/70 bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CircleHelp className="size-3.5" />
        Claude is asking
        {live && <span className="ml-auto size-1.5 animate-pulse rounded-full bg-primary" />}
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
