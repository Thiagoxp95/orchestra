'use client'
import { memo, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import type { NativeChatQuestion, NativeChatRequest } from '../../../desktop/src/shared/native-chat'
import type { NativeAnswerDraft } from '../../../desktop/src/shared/native-chat-ui'
import { cn } from './cn'

// Ports of t3code's ComposerPendingApprovalPanel and
// ComposerPendingUserInputPanel (MIT). Both pin inside the composer shell above
// the textarea; the approve/deny and Previous/Next/Submit clusters replace the
// send button (ChatPane wires those). State lives in ChatPane — as in t3code's
// ChatView — because the composer textarea doubles as the custom answer field.

const AUTO_ADVANCE_MS = 200

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  request,
  pendingCount,
}: {
  request: NativeChatRequest
  pendingCount: number
}) {
  return (
    <div role="group" aria-label={request.title} className="flex min-w-0 flex-col items-start gap-1 px-2 pt-1">
      <span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 truncate font-medium text-warning">{request.title}</span>
        {pendingCount > 1 && <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>}
      </span>
      {request.detail && (
        <code
          tabIndex={0}
          className="slim-scrollbar block max-h-20 w-full min-w-0 overflow-auto whitespace-pre font-mono text-xs text-foreground focus-visible:outline-none"
        >
          {request.detail}
        </code>
      )}
    </div>
  )
})

export function isQuestionAnswered(draft: NativeAnswerDraft, question: NativeChatQuestion): boolean {
  const answer = draft[question.id]
  return Boolean(answer && (answer.selected.length > 0 || answer.freeText.trim()))
}

export const PendingUserInputPanel = memo(function PendingUserInputPanel({
  request,
  questionIndex,
  answers,
  busy,
  onToggleOption,
  onAdvance,
}: {
  request: NativeChatRequest
  questionIndex: number
  answers: NativeAnswerDraft
  busy: boolean
  onToggleOption: (questionId: string, label: string) => void
  onAdvance: () => void
}) {
  const questions = request.questions ?? []
  const question = questions[Math.max(0, Math.min(questionIndex, questions.length - 1))]
  const [collapsedId, setCollapsedId] = useState<string | null>(null)
  const collapsed = question != null && collapsedId === question.id
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onAdvanceRef = useRef(onAdvance)
  useEffect(() => {
    onAdvanceRef.current = onAdvance
  }, [onAdvance])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const choose = (label: string) => {
    if (!question || busy) return
    onToggleOption(question.id, label)
    if (question.multiSelect) return
    // t3's auto-advance beat: the check shows for a moment, then the panel
    // moves on (or submits, on the last question).
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      onAdvanceRef.current()
    }, AUTO_ADVANCE_MS)
  }

  // Digit shortcuts while focus is outside an editable field (t3code).
  useEffect(() => {
    if (!question || busy || collapsed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      if (t instanceof HTMLElement && t.isContentEditable) return
      const digit = Number.parseInt(e.key, 10)
      if (!(digit >= 1 && digit <= 9)) return
      const option = question.options[digit - 1]
      if (!option) return
      e.preventDefault()
      choose(option.label)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!question) return null
  const answer = answers[question.id] ?? { selected: [], freeText: '' }
  const customActive = answer.freeText.trim().length > 0

  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        onClick={() => setCollapsedId(collapsed ? null : question.id)}
        title={collapsed ? 'Show the question and its options' : 'Hide the question and its options'}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-surface-hover"
      >
        <MessageCircleQuestion className="size-3.5 shrink-0 text-info-foreground" aria-hidden />
        <span className="shrink-0 font-medium text-muted-foreground">{request.title || 'Question'}</span>
        {collapsed && <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{question.question}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {questions.length > 1 && (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
              {questionIndex + 1}/{questions.length}
            </span>
          )}
          <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', collapsed && '-rotate-90')} />
        </span>
      </button>
      {!collapsed && (
        <div className="slim-scrollbar max-h-[40vh] overflow-y-auto px-2 pb-1 [overflow-wrap:anywhere]">
          <p className="text-sm text-foreground/85">{question.question}</p>
          {question.multiSelect && <p className="mt-1 text-xs text-muted-foreground">Select one or more options.</p>}
          <div className="mt-2 space-y-0.5">
            {question.options.map((option, index) => {
              const selected = !customActive && answer.selected.includes(option.label)
              return (
                <button
                  key={`${question.id}:${option.label}`}
                  type="button"
                  disabled={busy}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(option.label)}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/25',
                    selected ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-surface-hover',
                    busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.label}</span>
                    {option.description && option.description !== option.label && (
                      <span className="text-[11px] text-muted-foreground">{option.description}</span>
                    )}
                  </div>
                  {selected ? (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  ) : index < 9 ? (
                    <kbd className="flex size-5 shrink-0 items-center justify-center font-sans text-[10px] font-medium tabular-nums text-muted-foreground">
                      {index + 1}
                    </kbd>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})
