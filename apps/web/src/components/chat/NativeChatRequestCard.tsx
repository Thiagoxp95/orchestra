'use client'

import { useState } from 'react'
import type {
  NativeChatReply,
  NativeChatRequest,
} from '../../../../desktop/src/shared/native-chat'
import {
  buildNativeAnswers,
  type NativeAnswerDraft,
} from '../../../../desktop/src/shared/native-chat-ui'
import { cn } from '@/lib/utils'

export function NativeChatRequestCard({
  request,
  onRespond,
}: {
  request: NativeChatRequest
  onRespond: (reply: NativeChatReply) => Promise<unknown>
}) {
  const [answers, setAnswers] = useState<NativeAnswerDraft>(() =>
    Object.fromEntries(
      (request.questions ?? []).map((question) => [
        question.id,
        { selected: [], freeText: '' },
      ]),
    ),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const respond = async (reply: NativeChatReply) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onRespond(reply)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send response')
      setBusy(false)
    }
  }

  const questions = request.questions ?? []
  const complete =
    questions.length > 0 &&
    questions.every((question) => {
      const answer = answers[question.id]
      return Boolean(answer && (answer.selected.length > 0 || answer.freeText.trim()))
    })

  return (
    <section className="mb-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
      <div className="text-sm font-medium text-foreground">{request.title}</div>
      {request.detail && (
        <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{request.detail}</div>
      )}
      {request.kind === 'approval' ? (
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void respond({ requestId: request.id, decision: 'allow' })} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40">Allow</button>
          <button type="button" disabled={busy} onClick={() => void respond({ requestId: request.id, decision: 'deny' })} className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-40">Deny</button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {questions.map((question) => {
            const answer = answers[question.id] ?? { selected: [], freeText: '' }
            return (
              <fieldset key={question.id} disabled={busy} className="space-y-2">
                <legend className="text-xs font-medium text-foreground">{question.question}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {question.options.map((option) => {
                    const selected = answer.selected.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        title={option.description}
                        aria-pressed={selected}
                        onClick={() => setAnswers((current) => {
                          const previous = current[question.id] ?? { selected: [], freeText: '' }
                          const nextSelected = question.multiSelect
                            ? selected
                              ? previous.selected.filter((value) => value !== option.label)
                              : [...previous.selected, option.label]
                            : [option.label]
                          return { ...current, [question.id]: { selected: nextSelected, freeText: '' } }
                        })}
                        className={cn('rounded-lg border px-2.5 py-1.5 text-left text-xs disabled:opacity-40', selected ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-surface-hover')}
                      >
                        <span>{option.label}</span>
                        {option.description && <span className="ml-1 text-muted-foreground/70">— {option.description}</span>}
                      </button>
                    )
                  })}
                </div>
                <input
                  value={answer.freeText}
                  onChange={(event) => {
                    const freeText = event.target.value
                    setAnswers((current) => ({ ...current, [question.id]: { selected: question.multiSelect ? (current[question.id]?.selected ?? []) : [], freeText } }))
                  }}
                  placeholder="Or type your answer"
                  className="w-full rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
                />
              </fieldset>
            )
          })}
          <button type="button" disabled={busy || !complete} onClick={() => void respond({ requestId: request.id, answers: buildNativeAnswers(answers) })} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40">
            {busy ? 'Submitting…' : questions.length > 1 ? 'Submit answers' : 'Submit answer'}
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
  )
}
