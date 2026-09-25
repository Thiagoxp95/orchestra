'use client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, ArrowDown, ChevronLeft, Loader2, ShieldOff, X } from 'lucide-react'
import {
  isNativeChatWorking,
  type NativeChatCommand,
  type NativeChatReply,
} from '../../../desktop/src/shared/native-chat'
import { buildNativeAnswers, classifyNativeDraft, type NativeAnswerDraft } from '../../../desktop/src/shared/native-chat-ui'
import { nativeChatModels } from '../../../desktop/src/shared/native-chat-catalog'
import { chromeVars, isLightColor } from './workspace-color'
import { cutAtReset, cutQueued, foldForDisplay } from './chat-messages'
import { deriveTimeline, type TimelineRow } from './chat-timeline'
import { cn } from './cn'
import { Composer, type ComposerAttachment } from './Composer'
import { ContextMeter } from './ContextMeter'
import { EffortControl, ModelPickerControl } from './ModelPicker'
import { countUserRows, makeNativeEcho, pruneNativeEchoes, type NativeEcho } from './native-messages'
import { isQuestionAnswered, PendingApprovalPanel, PendingUserInputPanel } from './PendingPanels'
import { ChatScopeContext, type ChatScope } from './Popover'
import {
  AssistantRow,
  DayDividerRow,
  QuestionRow,
  SystemRow,
  TurnFoldRow,
  UserRow,
  WorkingRow,
  WorkToggleRow,
} from './TimelineRows'
import type { ChatContextUsage, ChatDictation, ChatTransport } from './transport'
import { WorkRow } from './WorkRow'

// How close to the end still counts as "reading the live tail".
const NEAR_BOTTOM_PX = 80
// Scroller bottom inset before the composer is first measured.
const COMPOSER_FALLBACK_PX = 120
const MAX_ATTACHMENTS = 4
const NOTICE_MS = 6000

// Drafts outlive the pane: switching sessions (or the phone's foreground
// remount) must not eat a half-written message.
const drafts = new Map<string, string>()

type Attachment = ComposerAttachment & { file: File }

/** t3-style row rhythm: prose breathes (pb-4), work rows pack tight. */
function rowSpacing(row: TimelineRow): string {
  switch (row.kind) {
    case 'user':
      return 'pb-4'
    case 'assistant':
      return row.terminal ? 'pb-4' : 'pb-2'
    case 'work':
    case 'question':
      return 'pb-0.5'
    default:
      return 'pb-2'
  }
}

/** Drop focus after a phone send so the keyboard collapses onto the reply. */
function dismissSoftKeyboard(el: HTMLTextAreaElement | null): void {
  if (el && typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) el.blur()
}

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback

/**
 * The structured chat for one agent session — a one-to-one port of t3code's
 * chat UX (MessagesTimeline + ChatComposer) over a ChatTransport. It is an
 * overlay: the session's terminal stays mounted underneath untouched.
 */
export function ChatPane({
  sessionId,
  transport,
  color,
  surface,
  context,
  active = true,
  dictation,
}: {
  sessionId: string
  transport: ChatTransport
  /** Workspace color: re-tints the token ladder (see chat.css). */
  color?: string
  /** Pane background — the terminal's own, so the overlay reads as the same surface. */
  surface?: string
  context?: ChatContextUsage | null
  /** The pane is on screen: focus the composer (desktop pointers only). */
  active?: boolean
  /** Hold-to-talk on the composer card. Omitted = no mic (desktop). */
  dictation?: ChatDictation
}) {
  const snapshot = transport.useSnapshot(sessionId)
  const messages = transport.useMessages(sessionId)
  const provider = snapshot?.provider ?? 'claude'
  const settings = snapshot?.settings
  const working = snapshot ? isNativeChatWorking(snapshot.status) : false
  const awaitingHost = (snapshot?.pendingCommands ?? 0) > 0
  const requests = snapshot?.requests ?? []
  const request = requests[0] ?? null

  const scope = useMemo<ChatScope>(
    () => ({
      style: (chromeVars(color) ?? undefined) as ChatScope['style'],
      tint: color && isLightColor(color) ? 'light' : 'dark',
    }),
    [color],
  )

  // ── Composer state ────────────────────────────────────────────────────────
  const [draft, setDraftState] = useState(() => drafts.get(sessionId) ?? '')
  const setDraft = useCallback(
    (next: string) => {
      drafts.set(sessionId, next)
      setDraftState(next)
    },
    [sessionId],
  )
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(() => () => attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.previewUrl)), [])
  const [echoes, setEchoes] = useState<NativeEcho[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [switchBusy, setSwitchBusy] = useState(false)
  const [respondBusy, setRespondBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    if (messages) setEchoes((prev) => pruneNativeEchoes(prev, messages))
  }, [messages])

  useEffect(() => {
    if (active && window.matchMedia?.('(pointer: fine)').matches) textareaRef.current?.focus({ preventScroll: true })
  }, [active])

  // ── Timeline ──────────────────────────────────────────────────────────────
  // Memoized: a composer keystroke re-renders the pane, and re-deriving up to
  // 400 rows per keypress is waste. Rows themselves are memo'd.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const rows = useMemo(() => {
    const all = [...(messages ?? []), ...echoes.map((e) => e.message)]
    return deriveTimeline(foldForDisplay(cutQueued(cutAtReset(all))), { working, expandedTurns, expandedGroups })
  }, [messages, echoes, working, expandedTurns, expandedGroups])
  const loaded = snapshot !== undefined && messages !== undefined
  const empty = loaded && rows.length === 0

  const toggleTurn = useCallback((turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }, [])

  // ── Scrolling ─────────────────────────────────────────────────────────────
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const composerWrapRef = useRef<HTMLDivElement | null>(null)
  const nearBottomRef = useRef(true)
  const jumpingRef = useRef(false)
  const tailKeyRef = useRef<string | null>(null)
  const [showLatest, setShowLatest] = useState(false)
  const [composerHeight, setComposerHeight] = useState(COMPOSER_FALLBACK_PX)

  // Expanding "+N previous tool calls" materializes rows ABOVE the button:
  // flush synchronously and shift scrollTop by the delta so the button never
  // moves under the pointer (t3's flushSync compensation).
  const toggleGroup = useCallback((groupId: string, anchor: HTMLElement) => {
    const el = scrollerRef.current
    const before = anchor.getBoundingClientRect().bottom
    flushSync(() => {
      setExpandedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(groupId)) next.delete(groupId)
        else next.add(groupId)
        return next
      })
    })
    if (!el || !anchor.isConnected) return
    const delta = anchor.getBoundingClientRect().bottom - before
    if (Math.abs(delta) >= 0.5) el.scrollTop += delta
  }, [])

  // The composer floats over the timeline; its height is the scroller's
  // bottom inset so no message hides behind the glass.
  useLayoutEffect(() => {
    const el = composerWrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > 0) setComposerHeight(el.offsetHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Composer growth fires no scroll event — re-pin in the same frame, or a
  // pinned reader's tail slides behind the glass.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [composerHeight])

  // Follow the tail — streaming rows grow in place, so the key includes the
  // last row's size, not just its uid. A reader scrolled back gets a pill.
  const last = messages?.[messages.length - 1]
  const tailKey = `${messages?.length ?? 0}:${last?.uid ?? ''}:${last ? JSON.stringify(last.blocks).length : 0}:${echoes.length}:${working ? 1 : 0}:${requests.length}`
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !loaded || tailKeyRef.current === tailKey) return
    tailKeyRef.current = tailKey
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        const again = scrollerRef.current
        if (again && nearBottomRef.current) again.scrollTop = again.scrollHeight
      })
    } else {
      setShowLatest(true)
    }
  }, [tailKey, loaded])

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    nearBottomRef.current = nearBottom
    if (nearBottom) jumpingRef.current = false
    setShowLatest(!nearBottom && !jumpingRef.current)
  }

  const jumpToLatest = () => {
    nearBottomRef.current = true
    jumpingRef.current = true
    setShowLatest(false)
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  const run = useCallback(
    async (command: NativeChatCommand, images?: File[]) => {
      await transport.command(sessionId, command, images)
    },
    [transport, sessionId],
  )

  const addFiles = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    const room = MAX_ATTACHMENTS - attachments.length
    if (images.length > room) flashNotice(`At most ${MAX_ATTACHMENTS} images per message`)
    const added = images.slice(0, Math.max(0, room)).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    if (added.length) setAttachments((prev) => [...prev, ...added])
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  const send = () => {
    const text = draft.trim()
    const sending = attachments
    if (!text && sending.length === 0) return false
    if (awaitingHost) {
      flashNotice('Waiting for the desktop to confirm the last message')
      return false
    }
    // `/compact` is Orchestra's to run; `/clear` is refused out loud. Sending
    // while the agent works is a steer: the provider reads it mid-turn.
    const classified = classifyNativeDraft(text, sending.map((a) => a.id), working)
    if ('error' in classified) {
      flashNotice(classified.error)
      return false
    }
    const command: NativeChatCommand =
      classified.command.kind === 'send'
        ? { kind: 'send', text: classified.command.text, ...(classified.command.steer ? { steer: true } : {}) }
        : classified.command
    const isMessage = command.kind === 'send'
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    if (isMessage) {
      const echo = makeNativeEcho(text, sending.length, countUserRows(messages ?? []), nonce)
      setEchoes((prev) => [...prev, echo])
      nearBottomRef.current = true
      setShowLatest(false)
    }
    setDraft('')
    setAttachments([])
    run(command, isMessage ? sending.map((a) => a.file) : undefined)
      .then(() => sending.forEach((a) => URL.revokeObjectURL(a.previewUrl)))
      .catch((cause: unknown) => {
        setEchoes((prev) => prev.filter((e) => e.message.uid !== `local:${nonce}`))
        // Hand the message back unless the reader already started another.
        if (!drafts.get(sessionId)) setDraft(text)
        setAttachments((prev) => (prev.length ? prev : sending))
        flashNotice(errorMessage(cause, 'Message was not sent'))
      })
    return true
  }

  const interrupt = () => {
    run({ kind: 'interrupt' }).catch((cause: unknown) => flashNotice(errorMessage(cause, 'Could not stop the agent')))
  }

  const configure = (next: { model?: string; effort?: string }) => {
    if (switchBusy) return
    setSwitchBusy(true)
    run({ kind: 'configure', settings: next })
      .catch((cause: unknown) => flashNotice(errorMessage(cause, 'Could not switch the model')))
      .finally(() => setSwitchBusy(false))
  }

  const models = useMemo(
    () => nativeChatModels(provider, snapshot?.models, settings?.model),
    [provider, snapshot?.models, settings?.model],
  )
  const currentModel = settings?.model
  const currentEffort = settings?.effort
  const efforts = models.find((m) => m.id === currentModel)?.efforts ?? (currentModel ? [] : models[0]?.efforts ?? [])
  // Stable identities for the memo'd pickers; they call the latest closure.
  const latest = useRef({ configure, models, currentModel, currentEffort })
  latest.current = { configure, models, currentModel, currentEffort }
  const onSelectModel = useCallback((model: string) => {
    const { configure, models, currentEffort } = latest.current
    const nextEfforts = models.find((m) => m.id === model)?.efforts ?? []
    configure({ model, ...(currentEffort && nextEfforts.includes(currentEffort) ? { effort: currentEffort } : {}) })
  }, [])
  const onSelectEffort = useCallback((effort: string) => {
    const { configure, currentModel } = latest.current
    configure({ ...(currentModel ? { model: currentModel } : {}), effort })
  }, [])

  // ── Pending request (approval / user input) ───────────────────────────────
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<NativeAnswerDraft>({})
  const requestId = request?.id ?? null
  useEffect(() => {
    setQuestionIndex(0)
    setAnswers(
      Object.fromEntries(
        (Array.isArray(request?.questions) ? request.questions : []).map((q) => [
          q.id,
          { selected: [], freeText: '' },
        ]),
      ),
    )
    setRespondBusy(false)
    respondBusyRef.current = false
    // Keyed by the request's identity: a new request never inherits stale picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  // Array.isArray, not `?? []`: a malformed wire shape must degrade to "no
  // questions", never throw inside render (it white-screened the whole app).
  const questions =
    request?.kind === 'question' && Array.isArray(request.questions) ? request.questions : []
  const activeQuestion = questions[Math.min(questionIndex, questions.length - 1)]
  const isLastQuestion = questionIndex >= questions.length - 1
  const formComplete = questions.length > 0 && questions.every((q) => isQuestionAnswered(answers, q))

  // A ref, not just state: the panel's auto-advance timer and a Submit tap
  // can both fire before React commits the busy flag.
  const respondBusyRef = useRef(false)
  useEffect(() => {
    respondBusyRef.current = respondBusy
  }, [respondBusy])
  const respond = (reply: NativeChatReply) => {
    if (respondBusyRef.current) return
    respondBusyRef.current = true
    setRespondBusy(true)
    run({ kind: 'respond', reply }).catch((cause: unknown) => {
      respondBusyRef.current = false
      setRespondBusy(false)
      flashNotice(errorMessage(cause, 'Could not send the response'))
    })
  }

  const toggleOption = useCallback(
    (questionId: string, label: string) => {
      setAnswers((prev) => {
        const q = questions.find((x) => x.id === questionId)
        const current = prev[questionId] ?? { selected: [], freeText: '' }
        const selected = q?.multiSelect
          ? current.selected.includes(label)
            ? current.selected.filter((x) => x !== label)
            : [...current.selected, label]
          : [label]
        return { ...prev, [questionId]: { selected, freeText: '' } }
      })
    },
    [questions],
  )

  // t3's onAdvance: the last question submits a complete form; otherwise next.
  // Fired 200ms after a single-select pick, so it reads the answers through a
  // ref that the pick's re-render has already refreshed.
  const answersRef = useRef(answers)
  answersRef.current = answers
  const advanceRef = useRef(() => {})
  advanceRef.current = () => {
    if (!request || request.kind !== 'question') return
    const current = answersRef.current
    if (!isLastQuestion) {
      setQuestionIndex((i) => Math.min(i + 1, questions.length - 1))
      return
    }
    if (questions.every((q) => isQuestionAnswered(current, q))) {
      respond({ requestId: request.id, answers: buildNativeAnswers(current) })
    }
  }
  const advance = useCallback(() => advanceRef.current(), [])

  const customAnswer = activeQuestion ? answers[activeQuestion.id]?.freeText ?? '' : ''
  const setCustomAnswer = (value: string) => {
    if (!activeQuestion) return
    setAnswers((prev) => ({
      ...prev,
      [activeQuestion.id]: {
        // t3: a typed answer overrides the picks; clearing it doesn't restore them.
        selected: value.trim() ? [] : prev[activeQuestion.id]?.selected ?? [],
        freeText: value,
      },
    }))
  }

  const questionMode = request?.kind === 'question' && activeQuestion != null
  const approvalMode = request?.kind === 'approval'
  const canSend = !request && (draft.trim().length > 0 || attachments.length > 0)

  // ── Dictation ─────────────────────────────────────────────────────────────
  // A transcript is appended to whatever the composer is editing right now —
  // the draft, or a question's free-text answer — and never auto-sent, so the
  // user reads it before it goes. Held in a ref because the sink is registered
  // once with the host, while its target changes on every keystroke.
  const appendSpokenRef = useRef<(text: string) => void>(() => undefined)
  appendSpokenRef.current = (text: string) => {
    const current = questionMode ? customAnswer : draft
    const next = current.trim() ? `${current.trimEnd()} ${text}` : text
    if (questionMode) setCustomAnswer(next)
    else setDraft(next)
  }
  useLayoutEffect(() => {
    dictation?.bindTranscript((text) => appendSpokenRef.current(text))
    return () => dictation?.bindTranscript(null)
  }, [dictation])

  // Mic permission, silence, a dead sidecar: the meter is gone by the time these
  // land, so they surface in the same notice pill everything else uses.
  useEffect(() => {
    if (dictation?.error) flashNotice(dictation.error)
  }, [dictation?.error, flashNotice])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape' && working && !request) {
      e.preventDefault()
      interrupt()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    const el = e.currentTarget
    if (questionMode) {
      const submits = isLastQuestion && formComplete
      advance()
      if (submits) dismissSoftKeyboard(el)
      return
    }
    if (approvalMode) return
    if (send()) dismissSoftKeyboard(el)
  }

  const placeholder = questionMode
    ? 'Type your own answer, or pick an option above'
    : approvalMode
      ? 'Approve or decline the request above'
      : snapshot?.status === 'starting'
        ? 'Starting the agent…'
        : snapshot?.status === 'compacting'
          ? 'Compacting the conversation…'
          : working
            ? 'Send a message to steer the agent'
            : 'Ask anything…'

  const requestActions = questionMode ? (
    <div className="flex shrink-0 items-center gap-1.5">
      {questionIndex > 0 && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setQuestionIndex((i) => Math.max(0, i - 1))}
          disabled={respondBusy}
          aria-label="Previous question"
          className="flex h-8 items-center justify-center rounded-full border border-border px-2 text-sm text-muted-foreground hover:bg-surface-hover disabled:opacity-40 sm:px-3"
        >
          <ChevronLeft className="size-3.5 sm:hidden" />
          <span className="hidden sm:inline">Previous</span>
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={advance}
        disabled={respondBusy || (isLastQuestion ? !formComplete : !isQuestionAnswered(answers, activeQuestion))}
        className={cn(
          'flex h-8 items-center justify-center rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.16)] disabled:opacity-40 sm:px-4',
          respondBusy && 'animate-pulse',
        )}
      >
        {respondBusy ? (
          'Submitting…'
        ) : (
          <>
            <span className="sm:hidden">{isLastQuestion ? 'Submit' : 'Next'}</span>
            <span className="hidden sm:inline">
              {!isLastQuestion ? 'Next question' : questions.length > 1 ? 'Submit answers' : 'Submit answer'}
            </span>
          </>
        )}
      </button>
    </div>
  ) : approvalMode && request ? (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        disabled={respondBusy}
        onClick={() => respond({ requestId: request.id, decision: 'deny' })}
        className="flex h-8 items-center justify-center rounded-full border border-border px-3 text-sm text-foreground hover:bg-surface-hover disabled:opacity-40"
      >
        Decline
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        disabled={respondBusy}
        onClick={() => respond({ requestId: request.id, decision: 'allow' })}
        className="flex h-8 items-center justify-center rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.16)] disabled:opacity-40"
      >
        Approve
      </button>
    </div>
  ) : undefined

  // Model/effort stay switchable mid-turn: the desktop saves the pick and the next turn runs it.
  const controlsLocked = awaitingHost || !snapshot
  const statusLine =
    snapshot?.status === 'starting'
      ? 'Starting the agent…'
      : snapshot?.status === 'compacting'
        ? 'Compacting the conversation…'
        : awaitingHost
          ? 'Waiting for the desktop…'
          : null
  const bannerError = snapshot?.error ?? (snapshot?.status === 'error' ? 'The agent stopped with an error.' : null)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ChatScopeContext.Provider value={scope}>
      <div
        className="chat-scope relative h-full min-h-0 select-text"
        data-tint={scope.tint}
        style={{ ...scope.style, backgroundColor: surface ?? 'var(--background)' }}
      >
        {/* One-finger native scroll only: no touch handlers, so the phone's
            two-finger SessionRoll gestures (on an ancestor) still work.
            touch-action:pan-y is what makes that true — with the default `auto`
            the browser claims a two-finger drag as pinch-zoom and fires
            touchcancel, which kills the roll/drawer gesture before it commits
            (xterm sets the same thing, which is why the terminal already works). */}
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="chat-timeline-scroll-fade slim-scrollbar h-full touch-pan-y overflow-y-auto overscroll-contain px-3 [overflow-anchor:none] sm:px-5"
          style={{ paddingBottom: composerHeight + 12 }}
        >
          {/* Short conversations hang off the BOTTOM (mt-auto, not
              justify-end: justify-end clips an overflowing column's top). */}
          <div className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col">
            <div className="h-4 shrink-0" />
            <div className="mt-auto min-w-0">
              {!loaded ? (
                <div className="flex min-h-[40vh] items-center justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
                </div>
              ) : empty ? (
                <div className="flex min-h-[40vh] flex-col items-center justify-center gap-1 px-6 text-center">
                  <p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>
                </div>
              ) : (
                rows.map((row) => (
                  <div key={row.id} className={cn('min-w-0', rowSpacing(row))}>
                    {row.kind === 'day' ? (
                      <DayDividerRow label={row.label} />
                    ) : row.kind === 'system' ? (
                      <SystemRow text={row.text} />
                    ) : row.kind === 'user' ? (
                      <UserRow row={row} previewUrls={undefined} />
                    ) : row.kind === 'assistant' ? (
                      <AssistantRow row={row} />
                    ) : row.kind === 'work' ? (
                      <WorkRow entry={row.entry} />
                    ) : row.kind === 'work-toggle' ? (
                      <WorkToggleRow row={row} onToggle={toggleGroup} />
                    ) : row.kind === 'turn-fold' ? (
                      <TurnFoldRow row={row} onToggle={toggleTurn} />
                    ) : row.kind === 'question' ? (
                      <QuestionRow block={row.block} />
                    ) : (
                      <WorkingRow sinceTs={row.sinceTs} />
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {showLatest && (
          <div
            className="pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 justify-center"
            style={{ bottom: composerHeight + 8 }}
          >
            <button
              type="button"
              onClick={jumpToLatest}
              className="chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <ArrowDown className="size-3.5" />
              Scroll to end
            </button>
          </div>
        )}

        <div ref={composerWrapRef} className="absolute inset-x-0 bottom-0 z-10 px-2 pb-2 sm:px-4 sm:pb-3">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
            {bannerError && (
              <div role="alert" className="chat-composer-glass flex items-start gap-2 rounded-xl border border-destructive/40 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{bannerError}</span>
              </div>
            )}
            {notice && (
              <div role="status" className="chat-composer-glass flex items-center gap-2 self-center rounded-full border border-border px-3 py-1 text-xs text-foreground">
                <span className="min-w-0 truncate">{notice}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3" />
                </button>
              </div>
            )}
            {statusLine && !bannerError && (
              <div role="status" className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {statusLine}
              </div>
            )}
            <Composer
              textareaRef={textareaRef}
              draft={questionMode ? customAnswer : draft}
              onDraftChange={questionMode ? setCustomAnswer : setDraft}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              attachments={attachments}
              onAddFiles={addFiles}
              onRemoveAttachment={removeAttachment}
              attachEnabled={!request && attachments.length < MAX_ATTACHMENTS}
              panel={
                request?.kind === 'approval' ? (
                  <PendingApprovalPanel request={request} pendingCount={requests.length} />
                ) : questionMode && request ? (
                  <PendingUserInputPanel
                    request={request}
                    questionIndex={questionIndex}
                    answers={answers}
                    busy={respondBusy}
                    onToggleOption={toggleOption}
                    onAdvance={advance}
                  />
                ) : undefined
              }
              controls={
                <>
                  <ModelPickerControl
                    provider={provider}
                    models={models}
                    currentModel={currentModel}
                    busy={switchBusy}
                    disabled={controlsLocked || switchBusy}
                    onSelectModel={onSelectModel}
                  />
                  <EffortControl
                    efforts={efforts}
                    currentEffort={currentEffort}
                    disabled={controlsLocked || switchBusy}
                    onSelectEffort={onSelectEffort}
                  />
                  {settings?.permissionMode === 'bypass' && (
                    <span
                      title="The agent runs without asking for approval (the session was launched with full access)"
                      className="ml-1 flex h-6 shrink-0 items-center gap-1 rounded-full border border-warning/30 px-2 text-[11px] font-medium text-warning"
                    >
                      <ShieldOff className="size-3" />
                      <span className="hidden sm:inline">Full access</span>
                    </span>
                  )}
                </>
              }
              meter={
                context ? (
                  <ContextMeter
                    usage={context}
                    onCompact={() => run({ kind: 'compact' }).catch((cause: unknown) => flashNotice(errorMessage(cause, 'Could not compact')))}
                    compactDisabled={working || !!request}
                  />
                ) : undefined
              }
              actions={requestActions}
              dictation={dictation}
              working={working}
              canSend={canSend}
              onSend={() => {
                if (send()) dismissSoftKeyboard(textareaRef.current)
              }}
              onStop={interrupt}
            />
          </div>
        </div>
      </div>
    </ChatScopeContext.Provider>
  )
}
