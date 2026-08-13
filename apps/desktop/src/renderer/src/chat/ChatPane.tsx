import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowDown, ChevronLeft, Loader2 } from 'lucide-react'
import { cn } from './lib/utils'
import {
  forgetUpload,
  loadComposer,
  parkComposer,
  patchParkedAttachment,
  pendingUpload,
  rememberUpload,
  type Attachment,
  type AttachmentPatch,
} from './lib/composer-draft'
import { QuestionRow } from './components/QuestionCard'
import { ComposerQuestionPanel } from './components/ComposerQuestionPanel'
import { EffortControl, ModelPickerControl, modelOptionLabel } from './components/ModelPicker'
import { useEventCallback } from './lib/useEventCallback'
import { Composer } from './components/Composer'
import { SlashSuggestions } from './components/SlashSuggestions'
import { WorkRow } from './components/WorkRow'
import {
  AssistantRow,
  DayDividerRow,
  SystemRow,
  TurnFoldRow,
  UserRow,
  WorkingRow,
  WorkToggleRow,
} from './components/TimelineRows'
import { deriveTimeline, type TimelineRow } from './lib/chat-timeline'
import { matchSlashCommands, mergeSlashCommands, type SlashCommand } from './lib/slash-commands'
import {
  adoptEchoPreviews,
  agentGateNotice,
  buildClaudeModelKeySteps,
  buildCodexModelKeySteps,
  buildQuestionKeySequence,
  canAnswerQuestionWithText,
  chatAboutSteps,
  cutAtReset,
  cutQueued,
  effectiveModelSelection,
  foldForDisplay,
  isDrivableQuestionForm,
  isQuestionAnswered,
  makeEcho,
  pruneEchoes,
  type AgentKind,
  type DisplayBlock,
  type KeyStep,
  type PendingEcho,
  type QuestionSelection,
} from './lib/chat-messages'
import { loadEchoes, parkEchoes } from './lib/pending-echoes'
import { useChatMessages } from './lib/useChatMessages'
import { chatScopeVars, isLightColor, terminalBg } from './lib/workspace-color'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

// How close to the end still counts as "reading the live tail". Generous enough
// that a trackpad's inertial settle doesn't count as scrolling away.
const NEAR_BOTTOM_PX = 80

// The Enter that submits a paste must trail the paste itself: sent in the same
// write, the TUI still has the bracketed-paste terminator in its input queue and
// swallows the CR as paste body. This pacing is the Orca-proven recipe.
const CR_DELAY_MS = 150

// If a submitted question form's answer never comes back (keys lost, form
// gone), unfreeze the Submitting… state so the user can retry.
const QUESTION_STUCK_MS = 15_000

// Attachment chips get unwieldy past this; the agent rarely needs more shots.
const MAX_ATTACHMENTS = 4

// Scroller bottom inset before the composer height is first measured — roughly
// one composer of clearance so the initial paint doesn't hide the tail.
const COMPOSER_FALLBACK_PX = 120

/** The last model/effort this pane applied to a session — display state only.
 *  baseModel/baseEffort are what the transcript reported at apply time, so the
 *  applied choice can yield once the transcript moves (effectiveModelSelection). */
type ModelChoice = { model?: string; effort?: string; baseModel?: string; baseEffort?: string }

// v2: entries written before the typed-slash-command fix recorded an effort the
// TUI never actually applied. Bumping the key retires those stuck labels.
function modelChoiceKey(sessionId: string): string {
  return `orchestra.agentModel.v2.${sessionId}`
}

function loadModelChoice(sessionId: string): ModelChoice {
  try {
    return JSON.parse(window.localStorage.getItem(modelChoiceKey(sessionId)) ?? '{}') as ModelChoice
  } catch {
    return {}
  }
}

/** Per-row bottom spacing, t3-style: rhythm lives on the wrapper, prose rows
 *  breathe (pb-4), work/commentary rows pack tight (pb-2). */
function rowSpacing(row: TimelineRow): string {
  switch (row.kind) {
    case 'user':
      return 'pb-4'
    case 'assistant':
      return row.terminal ? 'pb-4' : 'pb-2'
    case 'work':
    case 'question':
      return 'pb-0.5'
    case 'working':
      return 'pb-2'
    default:
      return 'pb-2'
  }
}

/** Read a picked image and stage it on disk, where the TUI can be handed its
 *  path. The phone's equivalent uploads to Convex storage and the bridge
 *  downloads it again; here the bytes are already local. */
async function stageAttachment(file: File): Promise<AttachmentPatch> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const filePath = await window.electronAPI.chatSaveImage(bytes, file.type || 'image/png')
    return { status: 'ready', filePath }
  } catch {
    return { status: 'error' }
  }
}

/**
 * The structured chat view of a session's agent conversation — the same surface
 * the phone reads, on the desktop. It renders the main process's parsed
 * transcript messages as a native-scrolling list, with a composer that writes
 * into the very PTY the terminal underneath is attached to. An overlay, not a
 * replacement: the terminal stays mounted below, so flipping back costs nothing.
 */
export function ChatPane({
  sessionId,
  color,
  working,
  agent,
  mirroredModel,
  mirroredEffort,
  contextTokens,
  contextWindow,
  exited,
  slashCommands,
  onShowTerminal,
}: {
  sessionId: string
  /** The workspace color — the background matches the terminal's so the overlay
   *  reads as the same surface. */
  color?: string
  /** The agent is mid-turn, so show the typing dots. */
  working: boolean
  /** Which CLI this session runs — gates the model picker. */
  agent?: AgentKind
  /** The model/effort the agent currently runs, raw as its transcript records
   *  them — what the model pill shows as current. */
  mirroredModel?: string
  mirroredEffort?: string
  /** Context-window occupancy — drives the composer's ring meter. */
  contextTokens?: number
  contextWindow?: number
  /** The session's PTY is gone (process exited), so sends must refuse loudly. */
  exited?: boolean
  /** The user's own commands (skills, ~/.claude/commands, plugins, this repo's
   *  .claude/commands), scanned by the main process. */
  slashCommands?: SlashCommand[]
  /** Flip back to the terminal view — the empty state's escape hatch. */
  onShowTerminal: () => void
}) {
  const { messages, seeded, hasEarlier, loadingEarlier, earlierError, loadEarlier, afterSeq } =
    useChatMessages(sessionId)

  // Parked outside the component like the draft: a send into a working agent may
  // not reach the transcript for minutes, so the echo is the only evidence of it.
  const [echoes, setEchoes] = useState<PendingEcho[]>(() => loadEchoes(sessionId))
  const [showLatest, setShowLatest] = useState(false)
  const [draft, setDraft] = useState(() => loadComposer(sessionId).draft)
  const [attachments, setAttachments] = useState<Attachment[]>(
    () => loadComposer(sessionId).attachments,
  )
  // Timeline expansion state — opened turn folds and "+N previous tool calls"
  // groups. Local by design: lost on remount, like t3 (reload resets folds).
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  // Slash autocomplete: highlight and Esc-dismissal are per-draft.
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [switchBusy, setSwitchBusy] = useState(false)
  // Codex prints its "Model changed" only in the terminal, so the pane flashes
  // its own confirmation; claude's slash commands echo back through the
  // transcript and need none.
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const [modelChoice, setModelChoice] = useState<ModelChoice>(() => loadModelChoice(sessionId))
  // Measured height of the floating composer overlay — the scroller's bottom
  // inset, so the last message can always scroll clear of the glass.
  const [composerHeight, setComposerHeight] = useState(COMPOSER_FALLBACK_PX)

  const scrollerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerWrapRef = useRef<HTMLDivElement>(null)
  // Object URLs for each echo's attached images, keyed by echo uid — lets the
  // optimistic bubble show real thumbnails. The transcript's copy that replaces
  // it only knows the on-disk path, which renders as a compact chip instead.
  const echoPreviewsRef = useRef(new Map<string, string[]>())
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Whether the user is reading the live end of the list. A ref, not state:
  // written from scroll events, read by the pin-to-bottom effect, and neither
  // should cause a render.
  const nearBottomRef = useRef(true)
  // scrollHeight captured just before a "load earlier" page is prepended, so
  // the layout effect can hold the reader's place while content grows above.
  const prependHeightRef = useRef<number | null>(null)
  // What the tail looked like at the last pin decision, so re-renders that
  // change nothing at the end (an expand, a prepend) don't re-pin or re-pill.
  const tailKeyRef = useRef<string | null>(null)
  // A programmatic smooth-scroll to the end is in flight: scroll frames along
  // the way must not re-show the pill the jump just dismissed.
  const jumpingRef = useRef(false)

  // Retire the echoes the transcript has caught up with, handing their
  // thumbnails to the real message first so the picture stays in the bubble
  // instead of collapsing to a chip.
  useEffect(() => {
    if (messages.length === 0) return
    setEchoes((prev) => {
      if (prev.length === 0) return prev
      for (const { from, to } of adoptEchoPreviews(prev, messages)) {
        const thumbs = echoPreviewsRef.current.get(from)
        if (!thumbs) continue
        echoPreviewsRef.current.set(to, thumbs)
        echoPreviewsRef.current.delete(from)
      }
      return pruneEchoes(prev, messages)
    })
  }, [messages])

  // ── Composer overlay measurement ──────────────────────────────────────────
  // The composer floats over the timeline (t3's layout); its measured height is
  // the scroller's bottom padding so no message ever hides behind the glass.
  useLayoutEffect(() => {
    const el = composerWrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (h > 0) setComposerHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Composer growth (textarea lines, attachment strip) grows the scroller's
  // paddingBottom without firing a scroll event — a pinned reader's tail would
  // silently slide behind the glass. Re-pin in the same frame.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [composerHeight])

  // ── Stick to bottom ───────────────────────────────────────────────────────
  // Native scrolling is the whole point of this pane, so following the tail is
  // done by pinning scrollTop after content grows — but only for a reader who
  // was at the bottom; anyone reading back gets a "scroll to end" pill instead
  // of a yank. The rAF re-pin covers late layout (fonts, the dots mounting).
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !seeded) return
    if (prependHeightRef.current != null) {
      // Earlier page landed above the viewport: keep the reader's place.
      el.scrollTop += el.scrollHeight - prependHeightRef.current
      prependHeightRef.current = null
      return
    }
    const tailKey = `${messages.length > 0 ? messages[messages.length - 1].seq : -1}:${echoes.length}:${working ? 1 : 0}`
    if (tailKeyRef.current === tailKey) return
    tailKeyRef.current = tailKey
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        const el2 = scrollerRef.current
        if (el2 && nearBottomRef.current) el2.scrollTop = el2.scrollHeight
      })
    } else {
      setShowLatest(true)
    }
  }, [messages, echoes, working, seeded])

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    nearBottomRef.current = nearBottom
    if (nearBottom) jumpingRef.current = false
    // t3 semantics: the pill appears the moment the reader leaves the live end,
    // not only when new content arrives behind their back. Same-value setState
    // is a no-op, so this costs nothing per scroll frame.
    setShowLatest(!nearBottom && !jumpingRef.current)
  }

  const jumpToLatest = () => {
    nearBottomRef.current = true
    jumpingRef.current = true
    setShowLatest(false)
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
  }

  // Arm the hold-the-reader's-place anchor in the same tick the prepend lands.
  const fetchEarlier = () =>
    loadEarlier((willPrepend) => {
      prependHeightRef.current = willPrepend ? (scrollerRef.current?.scrollHeight ?? null) : null
    })

  // Auto-load when the reader nears the top (t3-style infinite scroll; the
  // manual pill remains only as the error-retry affordance). The observer is
  // recreated per state change so its callback never closes over stale
  // loading/hasEarlier — and going loading → idle re-observes, which re-fires
  // immediately if the sentinel is still in range.
  const topSentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const root = scrollerRef.current
    if (!sentinel || !root) return
    if (!seeded || !hasEarlier || loadingEarlier || earlierError) return
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchEarlier()
      },
      // Start fetching well before the reader actually hits the top.
      { root, rootMargin: '600px 0px 0px 0px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
    // fetchEarlier is recreated every render; the states below are its guards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, hasEarlier, loadingEarlier, earlierError])

  // ── Display model ─────────────────────────────────────────────────────────
  // cutAtReset first: a reset marker means this session swapped to a different
  // conversation, so everything held before the marker is the old one and must
  // not render above the new. Echoes sit after the held rows, so a cut never
  // drops a pending send. cutQueued then retires the rows for messages that
  // have left claude's queue, so a steered message doesn't read as sent twice.
  // Memoized: a composer keystroke re-renders the pane, and re-deriving up to
  // 400 rows per keypress is waste.
  const { display, rows, liveQuestion } = useMemo(() => {
    const display = foldForDisplay(
      cutQueued(cutAtReset([...messages, ...echoes.map((e) => e.message)])),
    )
    const rows = deriveTimeline(display, { working, expandedTurns, expandedGroups })
    // The live question form: the conversation's last item is an assistant
    // message holding a question block with no result yet. Anything after it —
    // a result, an interrupt marker, even our own composer echo — means the
    // form is no longer safely drivable, so the card goes static.
    const lastItem = display.length > 0 ? display[display.length - 1] : null
    let liveQuestion: QuestionBlock | null = null
    if (lastItem?.role === 'assistant') {
      for (let i = lastItem.blocks.length - 1; i >= 0 && !liveQuestion; i--) {
        const b = lastItem.blocks[i]
        if (b.kind === 'question' && !b.result) liveQuestion = b
      }
    }
    return { display, rows, liveQuestion }
  }, [messages, echoes, working, expandedTurns, expandedGroups])
  const empty = seeded && display.length === 0

  // ── Sending ───────────────────────────────────────────────────────────────
  const sendWrite = (data: string) => {
    window.electronAPI.writeTerminal(sessionId, data, 'user')
  }

  // Key-protocol driver (question answers, model/effort switches): ONE call
  // carries the whole sequence and the MAIN process replays it with the delays
  // applied at the PTY. Not setTimeouts in here: claude's slash handling has a
  // real timing window (a CR ~350ms after "/effort high" executes it, one two
  // seconds later dies in the autocomplete popup), and a renderer starved by a
  // repaint would miss it. Conditional steps also read the live terminal
  // screen, which this pane cannot see.
  const sendKeySteps = async (steps: KeyStep[]) => {
    await window.electronAPI.chatKeySteps(sessionId, steps)
  }

  // ── Question form state ───────────────────────────────────────────────────
  // t3code keeps the pending-user-input drafts in ChatView, not the panel —
  // lifted here for the same reason: the composer textarea doubles as the
  // active question's custom-answer field, and the footer's send button
  // becomes the Previous / Next question / Submit answers cluster.
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionSelections, setQuestionSelections] = useState<QuestionSelection[]>([])
  const [questionBusy, setQuestionBusy] = useState(false)
  // Synchronous twin of questionBusy: the panel's auto-advance timer and a
  // footer Submit tap can both fire before React commits the state flip, and
  // each un-deduped run types the whole key sequence again.
  const questionBusyRef = useRef(false)
  const questionFormIdRef = useRef<string | null>(null)
  const questionStuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (questionStuckTimer.current) clearTimeout(questionStuckTimer.current)
    },
    [],
  )

  const liveQuestionKey = liveQuestion ? (liveQuestion.id ?? 'live-question') : null
  // Reset per tool_use so a new form never inherits stale picks. An effect, not
  // a key= remount: the state now spans the panel, the textarea, and the footer.
  useEffect(() => {
    if (questionFormIdRef.current === liveQuestionKey) return
    questionFormIdRef.current = liveQuestionKey
    setQuestionIndex(0)
    setQuestionSelections((liveQuestion?.questions ?? []).map(() => ({ optionIndexes: [] })))
    setQuestionBusy(false)
    questionBusyRef.current = false
    if (questionStuckTimer.current) clearTimeout(questionStuckTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the form's identity
  }, [liveQuestionKey])

  const formQuestions = liveQuestion?.questions ?? []
  const formDrivable = liveQuestion != null && isDrivableQuestionForm(formQuestions)
  const activeQuestionIndex = Math.max(0, Math.min(questionIndex, formQuestions.length - 1))
  const activeQuestion = formQuestions[activeQuestionIndex]
  const isLastQuestion = activeQuestionIndex >= formQuestions.length - 1
  // The composer textarea is the custom-answer field only where the TUI can
  // actually type one ("Type something." exists on plain single-select rows).
  const questionComposerActive =
    formDrivable && activeQuestion != null && canAnswerQuestionWithText(activeQuestion)
  const activeCustomAnswer = questionSelections[activeQuestionIndex]?.customAnswer ?? ''
  const questionCanAdvance =
    activeQuestion != null &&
    isQuestionAnswered(activeQuestion, questionSelections[activeQuestionIndex])
  const questionFormComplete =
    formQuestions.length > 0 &&
    questionSelections.length === formQuestions.length &&
    formQuestions.every((q, i) => isQuestionAnswered(q, questionSelections[i]))

  const submitQuestionForm = (sel: QuestionSelection[]) => {
    if (questionBusyRef.current) return
    const steps = buildQuestionKeySequence(formQuestions, sel)
    if (!steps) return
    questionBusyRef.current = true
    setQuestionBusy(true)
    // If the transcript's answer never comes back (keys lost, form gone),
    // unfreeze so the user can retry instead of staring at a dead "Submitting…".
    // Retries are safe: every step is screen-guarded, so a re-drive against an
    // already-answered form types nothing.
    if (questionStuckTimer.current) clearTimeout(questionStuckTimer.current)
    questionStuckTimer.current = setTimeout(() => {
      questionBusyRef.current = false
      setQuestionBusy(false)
    }, QUESTION_STUCK_MS)
    void sendKeySteps(steps).catch(() => {
      questionBusyRef.current = false
      setQuestionBusy(false)
    })
  }

  // t3's onAdvance: on the last question a complete form submits; otherwise
  // move to the next question.
  const advanceQuestionForm = (sel: QuestionSelection[] = questionSelections) => {
    if (!liveQuestion || questionBusy || questionBusyRef.current) return
    if (isLastQuestion) {
      if (formQuestions.every((q, i) => isQuestionAnswered(q, sel[i]))) submitQuestionForm(sel)
      return
    }
    setQuestionIndex(activeQuestionIndex + 1)
  }

  // t3code's togglePendingUserInputOptionSelection: single-select replaces the
  // pick, multi-select toggles, and either way the typed custom answer clears.
  const toggleQuestionOption = (oi: number): QuestionSelection[] => {
    const next = questionSelections.map((s, i) => {
      if (i !== activeQuestionIndex) return s
      if (activeQuestion?.multiSelect) {
        const has = s.optionIndexes.includes(oi)
        return {
          optionIndexes: has
            ? s.optionIndexes.filter((x) => x !== oi)
            : [...s.optionIndexes, oi],
          customAnswer: '',
        }
      }
      return { optionIndexes: [oi], customAnswer: '' }
    })
    setQuestionSelections(next)
    return next
  }

  // t3code's setPendingUserInputCustomAnswer: non-empty text drops the option
  // picks (the custom answer overrides them); clearing it doesn't restore them.
  const setQuestionCustomAnswer = (value: string) => {
    setQuestionSelections((prev) =>
      prev.map((s, i) =>
        i === activeQuestionIndex
          ? {
              optionIndexes: value.trim().length > 0 ? [] : s.optionIndexes,
              customAnswer: value,
            }
          : s,
      ),
    )
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  // Each picked image is staged on disk immediately (the chip spins until its
  // path lands); send then types "<path> <path> <text>" as a single submitted
  // paste, paced against the TUI's own silence.
  const trackUpload = (id: string, upload: Promise<AttachmentPatch>) => {
    rememberUpload(id, upload)
    void upload.then((patch) => {
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
      patchParkedAttachment(sessionId, id, patch)
    })
  }

  // Chips restored from the park may still carry a previous mount's in-flight
  // staging; re-attach to it here or they spin forever and block send.
  useEffect(() => {
    for (const a of attachments) {
      if (a.status !== 'uploading') continue
      const upload = pendingUpload(a.id)
      if (upload) trackUpload(a.id, upload)
    }
    // Mount only: every later 'uploading' chip is tracked by addFiles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length
    for (const file of files.slice(0, Math.max(0, room))) {
      if (!file.type.startsWith('image/')) continue
      const id = crypto.randomUUID()
      setAttachments((prev) => [
        ...prev,
        {
          id,
          previewUrl: URL.createObjectURL(file),
          mime: file.type || 'image/png',
          status: 'uploading',
        },
      ])
      trackUpload(id, stageAttachment(file))
    }
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Allow re-picking the same screenshot back-to-back.
    e.target.value = ''
    addFiles(files)
  }

  /**
   * Cmd-V of a screenshot. Bound on the pane root so it works wherever focus
   * sits inside the chat (textarea, a chip, the timeline). Text pastes fall
   * through untouched — only an image clipboard is intercepted.
   *
   * `clipboardData.files` is empty for a raw bitmap on some paths (copying out
   * of Preview/an editor rather than a Finder file), so the items list is the
   * fallback; the two overlap, hence the dedupe by identity.
   */
  const onPasteFiles = (e: React.ClipboardEvent) => {
    const data = e.clipboardData
    if (!data) return
    const images = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'))
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file && !images.some((f) => f.name === file.name && f.size === file.size)) {
        images.push(file)
      }
    }
    if (images.length === 0) return
    e.preventDefault()
    if (attachments.length >= MAX_ATTACHMENTS) {
      flashNotice(`Up to ${MAX_ATTACHMENTS} images`)
      return
    }
    addFiles(images)
  }

  const removeAttachment = (id: string) => {
    forgetUpload(id)
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  // Park the composer on every change rather than from an unmount cleanup, so
  // switching sessions (or closing the pane mid-sentence) keeps what was typed.
  useEffect(() => {
    parkComposer(sessionId, { draft, attachments })
  }, [sessionId, draft, attachments])

  // Same deal for in-flight sends: park on change, so the echo survives a flip
  // to the terminal and back, and is gone the moment the transcript retires it.
  useEffect(() => {
    parkEchoes(sessionId, echoes)
  }, [sessionId, echoes])

  const readyAttachments = attachments.filter((a) => a.status === 'ready' && a.filePath)
  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length
  const canSend = (draft.trim().length > 0 || readyAttachments.length > 0) && uploadingCount === 0

  // ── Slash-command autocomplete ────────────────────────────────────────────
  // Claude-only: the catalog is claude-code's built-ins plus the user's own
  // skills/commands; codex has its own (different) commands and its /model flow
  // already goes through the picker.
  const slashCatalog = useMemo(() => mergeSlashCommands(slashCommands), [slashCommands])
  // No slash popup while a question form is pending: the textarea is the form's
  // custom-answer field then, and a stale draft underneath must not resurface
  // the command list over the option rows.
  const slashMatches = useMemo(
    () => (agent === 'claude' && !liveQuestion ? matchSlashCommands(draft, 20, slashCatalog) : []),
    [agent, draft, slashCatalog, liveQuestion],
  )
  const slashOpen = slashMatches.length > 0 && !slashDismissed
  const slashIndex = Math.min(slashHighlight, slashMatches.length - 1)
  useEffect(() => {
    setSlashHighlight(0)
    setSlashDismissed(false)
  }, [draft])
  // Trailing space: harmless on argument-less commands, and it both closes the
  // box (the draft is no longer a bare command) and tees up typing an argument.
  const acceptSlash = (cmd: SlashCommand) => setDraft(`/${cmd.name} `)

  /** Returns whether the message actually went out (see the gates below). */
  const sendDraft = (): boolean => {
    // Refuse, and SAY so — a message "sent" into a dead PTY vanishes without a
    // trace, which reads as the app dropping it. Same for a live PTY whose
    // agent CLI has exited (codex self-updates, prints "Please restart Codex",
    // and quits — the shell underneath eats every "sent" message).
    const gate = agentGateNotice(agent, exited)
    if (gate) {
      flashNotice(gate)
      return false
    }
    const text = draft.trim()
    const images = readyAttachments
    if (!text && images.length === 0) return false
    if (uploadingCount > 0) return false
    // Ctrl-U first: the TUI's input line may already hold text this composer
    // can't see (something typed straight into the terminal). Sending without
    // clearing would submit both copies glued together. Then bracketed paste:
    // the TUI takes the whole message as one paste instead of interpreting
    // newlines as submits. The CR that actually submits follows on its own
    // delayed write — see CR_DELAY_MS. With attachments the whole recipe moves
    // to the main process (chatSubmit), which paces every step against the
    // terminal's own silence: the TUI stops to read and encode each image path,
    // and a blind 150ms CR lands inside that window and is swallowed.
    const dispatch =
      images.length > 0
        ? () => {
            const body = [...images.map((a) => a.filePath), text].filter(Boolean).join(' ')
            void window.electronAPI.chatSubmit(sessionId, body)
          }
        : () => {
            sendWrite(`\x15\x1b[200~${text}\x1b[201~`)
            setTimeout(() => sendWrite('\r'), CR_DELAY_MS)
          }
    // A pending question form owns the TUI's keyboard — route through its
    // "Chat about this" item so the message lands as chat instead of raining
    // keystrokes onto the option list. It takes several keys on a preview-style
    // form (the row is unnumbered there), so this walks the steps rather than
    // sending one digit.
    const routeSteps = liveQuestion ? chatAboutSteps(liveQuestion.questions) : null
    if (routeSteps) {
      void sendKeySteps(routeSteps).then(dispatch)
    } else {
      dispatch()
    }
    const nonce = crypto.randomUUID()
    if (images.length > 0) {
      echoPreviewsRef.current.set(
        `local:${nonce}`,
        images.map((a) => a.previewUrl),
      )
    }
    setEchoes((prev) => [...prev, makeEcho(text, afterSeq, nonce, Date.now(), images.length)])
    // Sending is a statement that you're at the conversation's end.
    nearBottomRef.current = true
    setShowLatest(false)
    setDraft('')
    for (const a of images) forgetUpload(a.id)
    setAttachments((prev) => prev.filter((a) => a.status === 'error'))
    return true
  }

  // ── Model / effort switching ──────────────────────────────────────────────
  const flashNotice = (text: string) => {
    setSwitchNotice(text)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setSwitchNotice(null), 4000)
  }

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const applyModelChoice = async (model?: string, effort?: string) => {
    // A switch is still being typed into the TUI. Refusing is right — two
    // sequences interleaved would garble both — but refusing in silence is the
    // one thing this picker must never do.
    if (switchBusy) {
      flashNotice('Still switching — try again in a moment')
      return
    }
    // The popover can outlive the agent: the CLI dies while the picker is open
    // (or died moments before it opened). Driving the steps anyway would type
    // "/model …" into a bare shell — one more silent "the picker did nothing".
    const gate = agentGateNotice(agent, exited)
    if (!agent || gate) {
      if (gate) flashNotice(gate)
      return
    }
    // Claude switches model and effort with independent commands, so drive only
    // the halves that actually changed. Re-sending the current model is NOT a
    // harmless no-op: the picker holds bare aliases, so `/model opus` on a
    // session running `opus[1m]` would quietly drop it to the 200k variant.
    // Codex sets both in one picker pass, so it always sends the pair.
    const claudeModel = model !== currentSelection.model ? model : undefined
    const claudeEffort = effort !== currentSelection.effort ? effort : undefined
    const steps =
      agent === 'claude'
        ? buildClaudeModelKeySteps(claudeModel, claudeEffort)
        : model && effort
          ? buildCodexModelKeySteps(model, effort)
          : null
    if (!steps) {
      // Nothing to change (or an incomplete codex pair — its TUI picker sets
      // model and effort in one flow). SAY so: refusing in silence is
      // indistinguishable from the switch being dropped.
      const current = [
        modelOptionLabel(agent, 'model', currentSelection.model),
        modelOptionLabel(agent, 'effort', currentSelection.effort),
      ]
        .filter(Boolean)
        .join(' · ')
      flashNotice(
        agent === 'codex' && !(model && effort)
          ? `Current ${model ? 'effort' : 'model'} unknown — pick it first`
          : current
            ? `Already on ${current}`
            : 'Nothing to change',
      )
      return
    }
    setSwitchBusy(true)
    try {
      await sendKeySteps(steps)
    } catch {
      flashNotice('Switch failed — tap the pill to retry')
      return
    } finally {
      setSwitchBusy(false)
    }
    // Stamp what the transcript reported at apply time next to each field this
    // switch actually drove: the optimistic label yields as soon as the
    // transcript moves off this baseline (effectiveModelSelection). Only for the
    // fields sent now — an untouched field keeps its earlier baseline.
    const sentModel = agent === 'claude' ? claudeModel : model
    const sentEffort = agent === 'claude' ? claudeEffort : effort
    const next: ModelChoice = {
      ...modelChoice,
      ...(sentModel ? { model: sentModel, baseModel: mirroredModel } : {}),
      ...(sentEffort ? { effort: sentEffort, baseEffort: mirroredEffort } : {}),
    }
    setModelChoice(next)
    try {
      window.localStorage.setItem(modelChoiceKey(sessionId), JSON.stringify(next))
    } catch {
      // Storage full/blocked — the picker just forgets the label.
    }
    // Both CLIs print their "model changed" into the terminal only — none of it
    // reaches the transcript this view reads — so the pane flashes its own.
    const applied = [
      modelOptionLabel(agent, 'model', sentModel),
      modelOptionLabel(agent, 'effort', sentEffort),
    ]
      .filter(Boolean)
      .join(' · ')
    if (applied) flashNotice(`Switched to ${applied}`)
  }

  // Handed to the pickers instead of fresh closures: this pane re-renders on
  // every transcript append, and a picker re-rendering with it would repaint its
  // rows (and drop the clicks that land mid-repaint) while an agent streams.
  // Stable identity + memo means the pickers only repaint for their own state.
  //
  // Selecting applies IMMEDIATELY (t3code-style — no Apply step). Claude's
  // /model and /effort are independent commands, so each control drives only
  // its own half; codex's TUI picker sets both in one flow, so either control
  // pairs its pick with the session's current value for the other half.
  const onSelectModel = useEventCallback((value: string) => {
    void applyModelChoice(value, agent === 'codex' ? currentSelection.effort : undefined)
  })
  const onSelectEffort = useEventCallback((value: string) => {
    void applyModelChoice(agent === 'codex' ? currentSelection.model : undefined, value)
  })
  const onPickerNotice = useEventCallback((text: string) => flashNotice(text))

  // What the pill and the sheet treat as the session's current model/effort:
  // the transcript truth, bridged by a locally-applied choice until it catches up.
  const currentSelection = agent
    ? effectiveModelSelection(agent, modelChoice, mirroredModel, mirroredEffort)
    : {}

  // ── Timeline expansion ────────────────────────────────────────────────────
  const toggleTurn = (turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }

  // Expanding "+N previous tool calls" materializes rows ABOVE the clicked
  // button; measure the button, flush the state change synchronously, and shift
  // scrollTop by the delta so the button never moves under the cursor.
  const toggleGroup = (groupId: string, anchor: HTMLElement) => {
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
  }

  const contextRatio =
    contextTokens != null && contextWindow != null && contextWindow > 0
      ? Math.min(1, contextTokens / contextWindow)
      : null

  // ── Render ────────────────────────────────────────────────────────────────
  // The notice span renders even when the pill doesn't: refusals fired while no
  // agent runs (agentGateNotice) would otherwise flash into an unmounted slot
  // and never be seen — the exact silence they exist to break.
  const pickerGateNotice = agent ? agentGateNotice(agent, exited) : null
  const modelPill = agent || switchNotice ? (
    <div className="flex min-w-0 items-center gap-1.5">
      {agent && (
        <>
          <ModelPickerControl
            agent={agent}
            currentModel={currentSelection.model}
            currentEffort={currentSelection.effort}
            busy={switchBusy}
            disabled={switchBusy || !!liveQuestion || !!exited}
            gateNotice={pickerGateNotice}
            onSelectModel={onSelectModel}
            onNotice={onPickerNotice}
          />
          <EffortControl
            agent={agent}
            currentEffort={currentSelection.effort}
            disabled={switchBusy || !!liveQuestion || !!exited}
            gateNotice={pickerGateNotice}
            onSelectEffort={onSelectEffort}
            onNotice={onPickerNotice}
          />
        </>
      )}
      {switchNotice && (
        <span className="truncate text-[11px] text-muted-foreground">{switchNotice}</span>
      )}
    </div>
  ) : null

  return (
    <div
      className="chat-scope relative h-full select-text"
      // data-tint drives the shiki palette: its dual-theme tokens carry both a
      // light and a dark color, and a fixed dark pick is unreadable on a
      // light-tinted workspace.
      data-tint={color && isLightColor(color) ? 'light' : 'dark'}
      style={{ backgroundColor: terminalBg(color), ...(chatScopeVars(color) ?? {}) }}
      onPaste={onPasteFiles}
    >
      {/* The scroll-fade mask dissolves rows under the pane's floating
          Chat/Term pill instead of a hard top lane; [overflow-anchor:none]
          keeps the browser out of our own anchoring. */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="chat-timeline-scroll-fade slim-scrollbar h-full overflow-y-auto overscroll-contain px-3 [overflow-anchor:none] sm:px-5"
        style={{ paddingBottom: composerHeight + 12 }}
      >
        <div className="mx-auto w-full min-w-0 max-w-3xl">
          {/* Lane under the floating pill — content fades out through it. */}
          <div className="h-14" />
          {/* Infinite-scroll sentinel: nearing the top auto-fetches the next
              earlier page; the visible affordances are just a spinner and, on
              error, a manual retry pill. */}
          {hasEarlier && !empty && <div ref={topSentinelRef} aria-hidden className="h-px" />}
          {hasEarlier && !empty && (loadingEarlier || earlierError) && (
            <div className="flex justify-center pb-3">
              {earlierError && !loadingEarlier ? (
                <button
                  type="button"
                  onClick={() => void fetchEarlier()}
                  className="rounded-full border border-border bg-surface-raised px-3 py-1 text-[11px] text-muted-foreground hover:bg-surface-hover"
                >
                  Couldn&apos;t load older messages — retry
                </button>
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground/70" />
              )}
            </div>
          )}
          {empty ? (
            <div className="flex min-h-[60svh] flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground/50">
                No conversation yet — this session&apos;s transcript hasn&apos;t produced messages.
              </p>
              <button
                type="button"
                onClick={onShowTerminal}
                className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover"
              >
                Open terminal
              </button>
            </div>
          ) : (
            rows.map((row) => (
              <div key={row.id} className={cn('min-w-0', rowSpacing(row))}>
                {row.kind === 'day' ? (
                  <DayDividerRow label={row.label} />
                ) : row.kind === 'system' ? (
                  <SystemRow text={row.text} />
                ) : row.kind === 'user' ? (
                  <UserRow row={row} previewUrls={echoPreviewsRef.current.get(row.id)} />
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

      {showLatest && (
        <div
          className="pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 justify-center"
          style={{ bottom: composerHeight + 8 }}
        >
          <button
            type="button"
            onClick={jumpToLatest}
            className="chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <ArrowDown className="size-3.5" />
            Scroll to end
          </button>
        </div>
      )}

      {/* Composer — a glass overlay floating over the timeline (t3's layout);
          rows scroll behind it through the frosted surface. */}
      <div ref={composerWrapRef} className="absolute inset-x-0 bottom-0 z-10 px-2 pb-2">
        <div className="relative mx-auto w-full max-w-3xl">
          {slashOpen && (
            <SlashSuggestions
              matches={slashMatches}
              highlightIndex={slashIndex}
              onPick={acceptSlash}
            />
          )}
          <Composer
            panel={
              liveQuestion ? (
                <ComposerQuestionPanel
                  // Keyed per tool_use so a new form's panel timers reset too.
                  key={liveQuestionKey ?? 'live-question'}
                  questions={formQuestions}
                  questionIndex={activeQuestionIndex}
                  selections={questionSelections}
                  busy={questionBusy}
                  onToggleOption={toggleQuestionOption}
                  onAdvance={advanceQuestionForm}
                />
              ) : undefined
            }
            questionActions={
              formDrivable ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  {activeQuestionIndex > 0 && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setQuestionIndex(activeQuestionIndex - 1)}
                      disabled={questionBusy}
                      aria-label="Previous question"
                      className="flex h-8 items-center justify-center rounded-full border border-border/70 px-2 text-sm text-muted-foreground hover:bg-surface-hover disabled:opacity-40 sm:px-3"
                    >
                      <ChevronLeft className="size-3.5 sm:hidden" />
                      <span className="hidden sm:inline">Previous</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => advanceQuestionForm()}
                    disabled={
                      questionBusy || (isLastQuestion ? !questionFormComplete : !questionCanAdvance)
                    }
                    className={cn(
                      'flex h-8 items-center justify-center rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.16)] disabled:opacity-40 sm:px-4',
                      questionBusy && 'animate-pulse',
                    )}
                  >
                    {questionBusy ? (
                      'Submitting…'
                    ) : !isLastQuestion ? (
                      'Next question'
                    ) : formQuestions.length > 1 ? (
                      'Submit answers'
                    ) : (
                      'Submit answer'
                    )}
                  </button>
                </div>
              ) : undefined
            }
            draft={questionComposerActive ? activeCustomAnswer : draft}
            onDraftChange={questionComposerActive ? setQuestionCustomAnswer : setDraft}
            onSend={sendDraft}
            canSend={canSend}
            working={working}
            onInterrupt={() => sendWrite('\x1b')}
            attachments={attachments}
            onPickFiles={() => fileInputRef.current?.click()}
            onRemoveAttachment={removeAttachment}
            attachEnabled={attachments.length < MAX_ATTACHMENTS}
            modelPill={modelPill}
            contextRatio={contextRatio}
            onTextareaKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const n = slashMatches.length
                  setSlashHighlight((slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashDismissed(true)
                  return
                }
                if (e.key === 'Tab') {
                  e.preventDefault()
                  acceptSlash(slashMatches[slashIndex])
                  return
                }
                // Enter completes the highlighted command — unless it's already
                // typed out in full, where a second required Enter would read
                // as a dropped send.
                if (e.key === 'Enter' && !e.shiftKey) {
                  const hl = slashMatches[slashIndex]
                  if (hl && draft.trim() !== `/${hl.name}`) {
                    e.preventDefault()
                    acceptSlash(hl)
                    return
                  }
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                // t3code: while a drivable form is pending, Enter walks the
                // form (Next question / Submit) instead of sending a message.
                if (formDrivable) {
                  advanceQuestionForm()
                  return
                }
                sendDraft()
              }
            }}
            placeholder={
              agentGateNotice(agent, exited) ??
              (questionComposerActive
                ? 'Type your own answer, or leave this blank to use the selected option'
                : formDrivable && activeQuestion?.multiSelect
                  ? 'Select one or more options above'
                  : formDrivable
                    ? 'Pick an option above'
                    : liveQuestion
                      ? 'Or reply in your own words…'
                      : 'Message the agent')
            }
          />
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPickFiles}
      />
    </div>
  )
}
