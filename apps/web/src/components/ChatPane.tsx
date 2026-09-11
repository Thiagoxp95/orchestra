'use client'

import { useComposerDraft } from '../lib/useComposerDraft'
import { useChatPending } from '@/lib/useChatPending'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { ArrowDown, ChevronLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  forgetUpload,
  patchParkedAttachment,
  pendingUpload,
  rememberUpload,
  type AttachmentPatch,
} from '../lib/composer-draft'
import { useDictation } from '../hooks/useDictation'
import { releaseHiddenKeyboardFocus } from '../lib/viewport'
import { terminalBg } from '../lib/terminal-theme'
import { QuestionRow } from './QuestionCard'
import { ComposerQuestionPanel } from './chat/ComposerQuestionPanel'
import { TuiPromptCard } from './chat/TuiPromptCard'
import { NativeChatRequestCard } from './chat/NativeChatRequestCard'
import { EffortControl, ModelPickerControl, modelOptionLabel } from './chat/ModelPicker'
import { useEventCallback } from '../hooks/useEventCallback'
import { Composer } from './chat/Composer'
import { SlashSuggestions } from './chat/SlashSuggestions'
import { WorkRow } from './chat/WorkRow'
import {
  AssistantRow,
  DayDividerRow,
  SystemRow,
  TurnFoldRow,
  UserRow,
  WorkingRow,
  WorkToggleRow,
} from './chat/TimelineRows'
import { deriveTimeline, type TimelineRow } from '../lib/chat-timeline'
import { matchSlashCommands, mergeSlashCommands, type SlashCommand } from '../lib/slash-commands'
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
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
  findLiveQuestion,
  foldForDisplay,
  isDrivableQuestionForm,
  isQuestionAnswered,
  makeEcho,
  mergeMessages,
  parseModelCommand,
  pruneEchoes,
  type AgentKind,
  type ChatBlock,
  type ChatMessage,
  type DisplayBlock,
  type KeyStep,
  type QuestionSelection,
  type SeqChatMessage,
  type TuiPrompt,
} from '../lib/chat-messages'
import { usePendingEchoes } from '../lib/usePendingEchoes'
import { useNativeChat } from '../lib/useNativeChat'
import { isNativeChatWorking } from '../../../desktop/src/shared/native-chat'
import {
  classifyNativeDraft,
  nativeChatPickerCatalog,
  parseNativeModelCommand,
  shouldUseNativeInterrupt,
} from '../../../desktop/src/shared/native-chat-ui'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

// One backfill page. Matches the desktop tailer's first-attach window closely
// enough that the first page usually IS the whole retained conversation.
const PAGE_SIZE = 60

// How close to the end still counts as "reading the live tail". Generous enough
// that the rubber-band settle after a flick doesn't count as scrolling away.
const NEAR_BOTTOM_PX = 80

// If a submitted question form's answer never comes back (keys lost, form
// gone), unfreeze the Submitting… state so the user can retry.
const QUESTION_STUCK_MS = 15_000

// Attachment chips get unwieldy past this; the agent rarely needs more shots.
const MAX_ATTACHMENTS = 4

// Scroller bottom inset before the composer height is first measured — roughly
// one composer of clearance so the initial paint doesn't hide the tail.
const COMPOSER_FALLBACK_PX = 120

/**
 * Drop composer focus after a phone send so the on-screen keyboard collapses and
 * the reply lands on a full-height timeline. Gated on a coarse pointer: on a
 * hardware keyboard nothing is covering the view and blurring would break
 * back-to-back messages.
 */
function dismissSoftKeyboard(el: HTMLTextAreaElement): void {
  if (typeof window === 'undefined') return
  if (!window.matchMedia('(pointer: coarse)').matches) return
  el.blur()
}

/** The last model/effort this pane applied to a session — display state only.
 *  baseModel/baseEffort are what the mirror reported at apply time, so the
 *  applied choice can yield to the mirror once it moves (see
 *  effectiveModelSelection). */
type ModelChoice = { model?: string; effort?: string; baseModel?: string; baseEffort?: string }

// v2: entries written before the typed-slash-command fix recorded an effort the
// TUI never actually applied, and the optimistic label outlives the mirror for
// as long as the mirror keeps reporting the apply-time baseline — i.e. forever,
// since the switch never happened. Bumping the key retires those stuck labels.
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

// What a mirrored agentMessages row looks like over the wire. Convex adds its
// own fields (_id, _creationTime); this picks out just the message.
type WireMessage = { uid: string; seq: number; role: string; blocks?: unknown; ts?: number }

const ROLES: readonly string[] = ['user', 'assistant', 'tool', 'system']

function toMessage(row: WireMessage): SeqChatMessage {
  return {
    uid: row.uid,
    seq: row.seq,
    // An unknown role from a newer desktop renders as a system line rather
    // than crashing the pane on a shape this build has never seen.
    role: ROLES.includes(row.role) ? (row.role as ChatMessage['role']) : 'system',
    blocks: Array.isArray(row.blocks) ? (row.blocks as ChatBlock[]) : [],
    ts: row.ts,
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

/**
 * The structured chat view of a session's agent conversation — the phone's
 * primary READING surface. Renders the desktop-parsed transcript messages as a
 * native-scrolling list (local paint, zero round trips), with a composer that
 * writes to the same PTY the terminal underneath is attached to. It is an
 * overlay, not a replacement: TerminalPane stays mounted below (see its
 * `chatOverlay` prop), so flipping to the terminal costs nothing.
 */
export function ChatPane({
  token,
  sessionId,
  color,
  working: legacyWorking,
  agent: legacyAgent,
  mirroredModel: legacyMirroredModel,
  mirroredEffort: legacyMirroredEffort,
  contextTokens,
  contextWindow,
  exited: legacyExited,
  canResume,
  tuiPrompt: legacyTuiPrompt,
  slashCommands,
  onShowTerminal,
}: {
  token: string
  sessionId: string
  /** The workspace color — backgrounds match terminalBg so the overlay reads as the same surface. */
  color?: string
  /** Mirrored liveStatus verdict: the agent is mid-turn, so show the typing dots. */
  working: boolean
  /** Which CLI this session runs (mirrored processStatus) — gates the model picker. */
  agent?: AgentKind
  /** The model/effort the agent currently runs, raw as its transcript records
   *  them (mirrored liveStatus) — what the model pill shows as current. */
  mirroredModel?: string
  mirroredEffort?: string
  /** Mirrored context-window occupancy — drives the composer's ring meter. */
  contextTokens?: number
  contextWindow?: number
  /** Mirrored liveStatus verdict: the session's PTY is gone (process exited, or
   *  its daemon died). Nothing is listening, so sends must refuse loudly —
   *  the bridge drops writes to such sessions rather than let them vanish. */
  exited?: boolean
  /** The desktop still knows which conversation this pane was holding, so an
   *  `exited` session is not a dead end: sending resumes it and delivers the
   *  message into the conversation that comes back. See sendDraft. */
  canResume?: boolean
  /** A TUI-native prompt (folder trust, permission) the desktop scraped off the
   *  terminal — no transcript record exists for it, so the chat renders it as a
   *  card the user can answer. Absent when nothing is prompting. */
  tuiPrompt?: TuiPrompt
  /** The user's own commands (skills, ~/.claude/commands, plugins, this repo's
   *  .claude/commands), scanned by the desktop and mirrored — merged into the
   *  built-in autocomplete catalog. */
  slashCommands?: SlashCommand[]
  /** Flip the page to the terminal view — the empty state's escape hatch for plain-shell sessions. */
  onShowTerminal: () => void
}) {
  const convex = useConvex()
  const nativeChat = useNativeChat(token, sessionId)
  const nativeSnapshot = nativeChat.snapshot ?? null
  const nativeActive = nativeSnapshot !== null
  const nativePending = (nativeSnapshot?.pendingCommands ?? 0) > 0
  const working = nativeSnapshot
    ? isNativeChatWorking(nativeSnapshot.status) || nativePending
    : legacyWorking
  const agent = nativeSnapshot?.provider ?? legacyAgent
  const mirroredModel = nativeSnapshot?.settings.model ?? legacyMirroredModel
  const mirroredEffort = nativeSnapshot?.settings.effort ?? legacyMirroredEffort
  const exited = nativeSnapshot ? nativeSnapshot.status === 'stopped' : legacyExited
  const tuiPrompt = nativeActive ? undefined : legacyTuiPrompt
  const nativePickerOptions = useMemo(
    () =>
      nativeSnapshot
        ? nativeChatPickerCatalog(
            nativeSnapshot.provider,
            nativeSnapshot.models,
            nativeSnapshot.settings.model,
            nativeSnapshot.provider === 'claude'
              ? { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }
              : { models: CODEX_MODELS, efforts: CODEX_EFFORTS },
          )
        : undefined,
    [nativeSnapshot],
  )
  const nativeMessages = useQuery(
    anyApi.nativeChat.messages,
    nativeActive ? { token, sessionId } : 'skip',
  ) as WireMessage[] | undefined

  const [messages, setMessages] = useState<SeqChatMessage[]>([])
  // The one-shot backfill has answered (even with nothing): the live tail may
  // subscribe, and an empty list now genuinely means "no conversation".
  const [seeded, setSeeded] = useState(false)
  // Single live cursor: the highest merged seq. Message cadence is seconds, so
  // the resubscribe gap that needed the terminal's dual chunk cursors does not
  // apply here — one cursor keeps it simple.
  const [afterSeq, setAfterSeq] = useState(-1)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // A failed earlier-page fetch parks the auto-loader behind a retry pill.
  const [earlierError, setEarlierError] = useState(false)
  // Parked outside the component like the draft, and for a sharper reason: a
  // send into a working agent may not reach the transcript for minutes, so the
  // echo is the only evidence of it — and losing it on the Term round-trip is
  // precisely how a sent message came to look dropped. See lib/pending-echoes.
  const [echoes, setEchoes] = usePendingEchoes(sessionId)
  const [showLatest, setShowLatest] = useState(false)
  // Composer contents outlive this pane: it is remounted on every foreground
  // (page.tsx keys TerminalPane by the resync nonce), so both halves are
  // hydrated from the park rather than starting empty. See lib/composer-draft.
  const { draft, attachments, setDraft, setAttachments, getDraftRevision, clearSubmittedDraft } = useComposerDraft(sessionId)
  // Timeline expansion state — opened turn folds and "+N previous tool calls"
  // groups. Local by design: lost on remount, like t3 (reload resets folds).
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  // Slash autocomplete: highlight and Esc-dismissal are per-draft — both reset
  // the moment the draft changes (see the effect by the derived matches).
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const { busy: switchBusy, start: startSwitch } = useChatPending(sessionId, 'model')
  const { busy: sendBusy, start: startSend } = useChatPending(sessionId, 'send')
  // Codex prints its "Model changed" only in the terminal, so the pane flashes
  // its own confirmation; claude's slash commands echo back through the
  // transcript and need none.
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const [nativeStartBusy, setNativeStartBusy] = useState(false)
  const [modelChoice, setModelChoice] = useState<ModelChoice>(() =>
    typeof window === 'undefined' ? {} : loadModelChoice(sessionId),
  )
  // Measured height of the floating composer overlay — the scroller's bottom
  // inset, so the last message can always scroll clear of the glass.
  const [composerHeight, setComposerHeight] = useState(COMPOSER_FALLBACK_PX)

  const scrollerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerWrapRef = useRef<HTMLDivElement>(null)
  // Object URLs for each echo's attached images, keyed by echo uid — lets the
  // optimistic bubble show real thumbnails. The mirrored copy that replaces it
  // only knows the desktop-side path, which renders as a compact chip instead.
  const echoPreviewsRef = useRef(new Map<string, string[]>())
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Whether the user is reading the live end of the list. A ref, not state:
  // it's written from scroll events and read by the pin-to-bottom effect, and
  // neither should cause a render.
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
  // A legacy history request can already be in flight when the reactive native
  // session projection arrives. Read the current mode after each await so that
  // stale legacy rows can never replace the native bounded feed.
  const nativeActiveRef = useRef(nativeActive)
  nativeActiveRef.current = nativeActive

  // Dictation transcripts land in the composer, not just the PTY: the desktop
  // types the text into the TUI input line (the terminal view's flow), which is
  // invisible from here — so mirror it into the draft where the user is looking,
  // editable before sending. sendDraft's leading Ctrl-U clears the TUI's copy.
  const dictation = useDictation(token, sessionId, (text) => {
    setDraft((d) => (d ? `${d.endsWith(' ') ? d : `${d} `}${text}` : text))
  })

  // ── Backfill: one-shot newest page, then let the live tail take over ──────
  useEffect(() => {
    if (nativeActive) return
    let cancelled = false
    void convex
      .query(anyApi.remote.getMessagesBefore, {
        token,
        sessionId,
        beforeSeq: Number.MAX_SAFE_INTEGER,
        limit: PAGE_SIZE,
      })
      .then((rows) => {
        if (cancelled || nativeActiveRef.current) return
        const page = ((rows ?? []) as WireMessage[]).map(toMessage)
        const asc = mergeMessages([], page)
        setMessages(asc)
        setAfterSeq(asc.length > 0 ? asc[asc.length - 1].seq : -1)
        // A full page means there is (probably) more history above; a short
        // one means this is the whole retained conversation.
        setHasEarlier(page.length >= PAGE_SIZE)
        setSeeded(true)
      })
      .catch(() => {
        // Offline or the backend predates the chat mirror: seed empty so the
        // live tail still subscribes and catches whatever arrives later.
        if (!cancelled && !nativeActiveRef.current) setSeeded(true)
      })
    return () => {
      cancelled = true
    }
  }, [convex, token, sessionId, nativeActive])

  useEffect(() => {
    if (!nativeActive) return
    setMessages([])
    setAfterSeq(-1)
    setHasEarlier(false)
    setEarlierError(false)
  }, [nativeActive, sessionId])

  // ── Live tail: subscribe above the highest merged seq ─────────────────────
  const live = useQuery(
    anyApi.remote.getMessages,
    !nativeActive && seeded ? { token, sessionId, afterSeq } : 'skip',
  ) as WireMessage[] | undefined

  // The Convex subscription surfaces as a value; folding it into the held list
  // is the "subscribe to an external store" case (same shape as useDictation's
  // result effect).
  useEffect(() => {
    if (nativeActive || !live || live.length === 0) return
    const incoming = live.map(toMessage)
    setMessages((prev) => mergeMessages(prev, incoming))
    setAfterSeq((cur) => incoming.reduce((top, m) => Math.max(top, m.seq), cur))
    setEchoes((prev) => {
      // Hand the echo's thumbnails to the transcript's copy before dropping it,
      // so the picture stays in the bubble instead of collapsing to a chip. Safe
      // inside the updater: re-running it finds the move already made (the source
      // key is gone) and does nothing.
      for (const { from, to } of adoptEchoPreviews(prev, incoming)) {
        const thumbs = echoPreviewsRef.current.get(from)
        if (!thumbs) continue
        echoPreviewsRef.current.set(to, thumbs)
        echoPreviewsRef.current.delete(from)
      }
      return pruneEchoes(prev, incoming)
    })
  }, [live, nativeActive])

  // Native turns update a stable message row while it streams. A cursor query
  // cannot see those in-place edits, so follow the native bounded snapshot too.
  useEffect(() => {
    if (!nativeMessages) return
    const incoming = nativeMessages.map(toMessage)
    setMessages(mergeMessages([], incoming))
    setAfterSeq(incoming.reduce((top, message) => Math.max(top, message.seq), -1))
    setHasEarlier(false)
    setEarlierError(false)
    setEchoes((current) => {
      for (const { from, to } of adoptEchoPreviews(current, incoming)) {
        const previews = echoPreviewsRef.current.get(from)
        if (!previews) continue
        echoPreviewsRef.current.set(to, previews)
        echoPreviewsRef.current.delete(from)
      }
      return pruneEchoes(current, incoming)
    })
    setSeeded(true)
  }, [nativeMessages])

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

  // Composer growth (textarea lines, attachment strip, dictation status) grows
  // the scroller's paddingBottom without firing a scroll event — a pinned
  // reader's tail would silently slide behind the glass. Re-pin in the same
  // frame the new padding is committed.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [composerHeight])

  // ── Stick to bottom ───────────────────────────────────────────────────────
  // Native scrolling is the whole point of this pane, so following the tail is
  // done by pinning scrollTop after content grows — but only for a reader who
  // was at the bottom; anyone reading back gets a "↓ latest" pill instead of a
  // yank. The rAF re-pin covers late layout (fonts, the working dots mounting).
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

  // ── Load earlier: infinite scroll above the lowest held seq ───────────────
  const loadEarlier = async () => {
    const lowest = messages.length > 0 ? messages[0].seq : null
    if (nativeActiveRef.current || loadingEarlier || lowest === null) return
    setLoadingEarlier(true)
    try {
      const rows = (await convex.query(anyApi.remote.getMessagesBefore, {
        token,
        sessionId,
        beforeSeq: lowest,
        limit: PAGE_SIZE,
      })) as WireMessage[] | null
      if (nativeActiveRef.current) return
      const page = (rows ?? []).map(toMessage)
      // Arm the hold-the-reader's-place anchor only when the page will
      // actually add rows above the viewport. An all-duplicate page (a retried
      // fetch, overlap with rows already held) merges to nothing, and an
      // anchor left armed by it would be consumed by the NEXT live append —
      // turning its stick-to-bottom pin into a one-off downward yank. The page
      // is entirely below our lowest seq, so a uid we don't hold yet is
      // exactly a row that will prepend.
      const held = new Set(messages.map((m) => m.uid))
      prependHeightRef.current = page.some((m) => !held.has(m.uid))
        ? (scrollerRef.current?.scrollHeight ?? null)
        : null
      // The held list may open on a user-less fragment: the tail of a turn
      // whose user message sits above the retention page. deriveTimeline
      // leaves that fragment unfolded (its rows are what the reader is looking
      // at). The page that brings its user message in completes the turn —
      // and a settled complete turn folds behind "Worked for Xs", collapsing
      // everything on screen into one line the instant the reader scrolls up.
      // Pre-expand it: the turn id is the user's uid, and the newest user row
      // of the page (with no reset marker after it) is the one that heads the
      // fragment.
      const firstHeld = messages.find((m) => m.role !== 'system')
      if (firstHeld && firstHeld.role !== 'user') {
        let headUid: string | null = null
        for (const m of page) {
          if (held.has(m.uid)) continue
          if (m.role === 'user') headUid = m.uid
          else if (m.role === 'system' && m.blocks.some((b) => b.kind === 'reset')) headUid = null
        }
        if (headUid) {
          const uid = headUid
          setExpandedTurns((prev) => {
            if (prev.has(uid)) return prev
            const next = new Set(prev)
            next.add(uid)
            return next
          })
        }
      }
      setMessages((prev) => mergeMessages(prev, page))
      setHasEarlier(page.length >= PAGE_SIZE)
      setEarlierError(false)
    } catch {
      // Keep hasEarlier so the retry pill renders; the auto-loader stands down
      // until the reader taps it (no hammering a failing backend on scroll).
      if (!nativeActiveRef.current) setEarlierError(true)
    } finally {
      setLoadingEarlier(false)
    }
  }

  // Auto-load when the reader nears the top (t3-style infinite scroll; the
  // manual pill remains only as the error-retry affordance). The observer is
  // recreated per state change so its callback never closes over stale
  // loading/hasEarlier — and going loading → idle re-observes, which re-fires
  // immediately if the sentinel is still in range (short pages cascade until
  // the viewport fills or history runs out; bounded by the 400-row cap).
  const topSentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const root = scrollerRef.current
    if (!sentinel || !root) return
    if (nativeActive || !seeded || !hasEarlier || loadingEarlier || earlierError) return
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadEarlier()
      },
      // Start fetching well before the reader actually hits the top, so the
      // scroll never slams into a hard edge.
      { root, rootMargin: '600px 0px 0px 0px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
    // loadEarlier is recreated every render; the states below are its guards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeActive, seeded, hasEarlier, loadingEarlier, earlierError])

  // ── Display model ─────────────────────────────────────────────────────────
  // cutAtReset first: a reset marker means the desktop swapped this session to
  // a different conversation and cleared the stored rows — everything held
  // before the marker is the old conversation and must not render above the
  // new one. Echoes sit after the held rows, so a cut never drops a pending
  // send. cutQueued then retires the rows for messages that have left claude's
  // queue, so a steered message doesn't read as having been sent twice.
  // Memoized: a composer keystroke re-renders the pane, and re-deriving up to
  // 400 rows (fold + timeline) per keypress is waste the old pane also paid —
  // don't inherit it.
  const { display, rows, liveQuestion } = useMemo(() => {
    const display = foldForDisplay(
      cutQueued(cutAtReset([...messages, ...echoes.map((e) => e.message)])),
    )
    const rows = deriveTimeline(display, { working, expandedTurns, expandedGroups })
    // The live question form: an unanswered question block that nothing has
    // moved past. A result, an interrupt marker, even our own composer echo
    // means the form is no longer safely drivable, so the card goes static —
    // see findLiveQuestion for the lone exception (its late-arriving preamble).
    const liveQuestion: QuestionBlock | null = nativeActive
      ? null
      : (findLiveQuestion(display)?.block ?? null)
    return { display, rows, liveQuestion }
  }, [messages, echoes, working, expandedTurns, expandedGroups, nativeActive])
  const empty = seeded && display.length === 0

  // ── Sending ───────────────────────────────────────────────────────────────
  const sendWrite = (data: string) => {
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId,
      kind: 'write',
      payload: { data, ...(data === '\x1b' ? { interruptChat: true } : {}) },
    }).catch((error: unknown) => {
      flashNotice(error instanceof Error ? error.message : 'Command was not sent — retry when connected')
    })
  }

  const interrupt = () => {
    if (!shouldUseNativeInterrupt(nativeActive, nativeStartBusy)) {
      sendWrite('\x1b')
      return
    }
    void nativeChat.command({ kind: 'interrupt' }).catch((cause: unknown) => {
      flashNotice(cause instanceof Error ? cause.message : 'Could not stop the agent')
    })
  }

  // Key-protocol driver (question answers, model/effort switches): ONE command
  // carries the whole sequence and the DESKTOP replays it with the delays
  // applied at the PTY. Per-step mutations with client-side sleeps do not
  // survive the trip — subscription jitter stretched or shrank every gap, and
  // claude's slash handling executes only when the CR lands ~350ms after the
  // command text (later CRs die in the autocomplete popup). That jitter is why
  // the picker "worked when probed, broken from the phone" for weeks.
  // Old desktops ignore `steps` and write the empty `data` — a no-op, never a
  // half-typed sequence. The local wait mirrors the sequence duration so
  // callers that chain a send behind it (chatAboutSteps routing) keep pacing.
  const sendKeySteps = async (steps: KeyStep[]) => {
    await convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId,
      kind: 'write',
      payload: { data: '', steps },
    })
    const totalMs = steps.reduce((n, s) => n + s.delayAfterMs, 0)
    if (totalMs > 0) await new Promise((r) => setTimeout(r, totalMs))
  }

  // ── Question form state ───────────────────────────────────────────────────
  // t3code keeps the pending-user-input drafts in ChatView, not the panel —
  // lifted here for the same reason: the composer textarea doubles as the
  // active question's custom-answer field, and the footer's send button
  // becomes the Previous / Next question / Submit answers cluster.
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionSelections, setQuestionSelections] = useState<QuestionSelection[]>([])
  const [questionBusy, setQuestionBusy] = useState(false)
  // Synchronous twin of questionBusy: the panel's 200ms auto-advance timer and
  // a footer Submit tap can both fire before React commits the state flip, and
  // each un-deduped run types the whole key sequence again (field bug: stray
  // "1"s in the TUI composer). A ref is checked-and-set in the same tick.
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

  // ── TUI-native prompt (folder trust / permission) ─────────────────────────
  // A prompt scraped off the terminal, not a transcript message: the agent is
  // blocked on it, so the card owns the composer until it's answered. Tapping an
  // option types its guarded keys into the TUI; the card retires when the mirror
  // stops reporting the prompt. Busy freezes the buttons so a double-tap can't
  // interleave two sequences. The flag clears whenever the prompt changes or
  // goes away (a new prompt, or the mirror moved off this one).
  const [tuiBusy, setTuiBusy] = useState(false)
  const tuiPromptKey = tuiPrompt ? `${tuiPrompt.kind}:${tuiPrompt.title}` : null
  useEffect(() => {
    setTuiBusy(false)
  }, [tuiPromptKey])

  const answerTuiPrompt = (optionIndex: number) => {
    if (!tuiPrompt || tuiBusy) return
    const option = tuiPrompt.options[optionIndex]
    if (!option) return
    setTuiBusy(true)
    void sendKeySteps(option.keys).catch(() => setTuiBusy(false))
    // Don't clear tuiBusy on success: the card stays frozen until the mirror
    // retires the prompt (or the next render swaps it), which is the real
    // confirmation the keys landed. If the keys were a no-op (stale guard), the
    // desktop clears the prompt on its next push anyway.
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  // Each picked image uploads to Convex storage immediately (chip shows a
  // spinner until its storageId lands); send then references the finished
  // uploads in one `sendChatMessage` command, and the desktop bridge downloads
  // them and types "<path> <path> <text>" as a single submitted paste.
  const uploadAttachment = async (file: File): Promise<AttachmentPatch> => {
    try {
      const mime = file.type || 'image/png'
      const url = (await convex.mutation(anyApi.remote.generateUploadUrl, { token })) as string
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': mime }, body: file })
      if (!res.ok) throw new Error(`upload failed (${res.status})`)
      const { storageId } = (await res.json()) as { storageId: string }
      return { status: 'ready', storageId }
    } catch {
      return { status: 'error' }
    }
  }

  // An upload may land after this mount is gone — a remount mid-upload is one
  // app switch away — so its result goes to the parked copy as well as to state.
  const trackUpload = (id: string, upload: Promise<AttachmentPatch>) => {
    rememberUpload(id, upload)
    void upload.then((patch) => {
      patchParkedAttachment(sessionId, id, patch)
    })
  }

  // Chips restored from the park still carry the previous mount's in-flight
  // uploads; re-attach to them here or they spin forever and block send.
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
      trackUpload(id, uploadAttachment(file))
    }
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Allow re-picking the same screenshot back-to-back.
    e.target.value = ''
    addFiles(files)
  }

  const removeAttachment = (id: string) => {
    forgetUpload(id)
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  const readyAttachments = attachments.filter((a) => a.status === 'ready' && a.storageId)
  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length
  const canSend = (draft.trim().length > 0 || readyAttachments.length > 0) && uploadingCount === 0

  // ── Slash-command autocomplete ────────────────────────────────────────────
  // Claude-only: the catalog is claude-code's built-ins plus the desktop's scan
  // of the user's own skills/commands; codex has its own (different) commands
  // and its /model flow already goes through the picker.
  const slashCatalog = useMemo(() => mergeSlashCommands(slashCommands), [slashCommands])
  // A deeper cap than the built-ins-only list used to need: with the user's own
  // commands merged in, a bare "/" is a browsable (scrolling) catalog rather
  // than a fixed top-8.
  // No slash popup while a question form is pending: the textarea is the
  // form's custom-answer field then, and a stale draft underneath must not
  // resurface the command list over the option rows.
  const slashMatches = useMemo(
    () =>
      agent === 'claude' && !liveQuestion && !tuiPrompt
        ? matchSlashCommands(draft, 20, slashCatalog)
        : [],
    [agent, draft, slashCatalog, liveQuestion, tuiPrompt],
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

  /**
   * Returns whether the message actually went out (see the gates below).
   *
   * `steer` is the composer's "send now": the desktop presses Esc before typing,
   * so a working agent reads this message instead of queueing it behind the turn
   * it is in the middle of. Old desktops ignore the flag and queue as before.
   */
  const sendDraft = ({ steer = false }: { steer?: boolean } = {}): boolean => {
    if (nativeStartBusy) {
      flashNotice('Native chat is starting')
      return false
    }
    if (nativeSnapshot) {
      if (nativeSnapshot.requests.length > 0) {
        flashNotice('Answer the request above first')
        return false
      }
      if (nativePending) {
        flashNotice('Waiting for desktop confirmation')
        return false
      }
      if (working && !steer) {
        flashNotice('The agent is working — use Steer to interrupt and send now')
        return false
      }
      if (nativePickerOptions) {
        const modelCommand = parseNativeModelCommand(draft, nativePickerOptions)
        if (modelCommand) {
          if ('error' in modelCommand) {
            flashNotice(modelCommand.error)
            return false
          }
          const submittedRevision = getDraftRevision()
          void applyModelChoice(modelCommand.model, modelCommand.effort).then((accepted) => {
            if (accepted) clearSubmittedDraft(submittedRevision)
          })
          return true
        }
      }
      const text = draft.trim()
      const images = readyAttachments
      if (!text && images.length === 0) return false
      if (uploadingCount > 0) return false
      const storageIds = images
        .map((attachment) => attachment.storageId)
        .filter((storageId): storageId is string => Boolean(storageId))
      const classified = classifyNativeDraft(text, storageIds, steer)
      if ('error' in classified) {
        flashNotice(classified.error)
        return false
      }
      const wireCommand =
        classified.command.kind === 'send'
          ? {
              kind: 'send' as const,
              text: classified.command.text,
              ...(classified.command.steer ? { steer: true } : {}),
            }
          : classified.command
      const submittedRevision = getDraftRevision()
      const finishSend = startSend()
      if (!finishSend) return false
      const nonce = crypto.randomUUID()
      const isMessage = wireCommand.kind === 'send'
      if (isMessage) {
        if (images.length > 0) {
          echoPreviewsRef.current.set(
            `local:${nonce}`,
            images.map((attachment) => attachment.previewUrl),
          )
        }
        setEchoes((current) => [
          ...current,
          makeEcho(text, afterSeq, nonce, Date.now(), images.length),
        ])
        nearBottomRef.current = true
        setShowLatest(false)
      }
      void nativeChat
        .command(
          wireCommand,
          isMessage
            ? images.map((image) => ({ storageId: image.storageId!, mime: image.mime }))
            : undefined,
        )
        .then(() => {
          clearSubmittedDraft(submittedRevision)
          if (!isMessage) return
          for (const image of images) forgetUpload(image.id)
          const sentIds = new Set(images.map((image) => image.id))
          setAttachments((current) => current.filter((image) => !sentIds.has(image.id)))
        })
        .catch((cause: unknown) => {
          if (isMessage) {
            setEchoes((current) =>
              current.filter((echo) => echo.message.uid !== `local:${nonce}`),
            )
            echoPreviewsRef.current.delete(`local:${nonce}`)
          }
          flashNotice(cause instanceof Error ? cause.message : 'Native chat command failed')
        })
        .finally(finishSend)
      return true
    }
    // Refuse, and SAY so — a message "sent" into a dead PTY vanishes without a
    // trace, which reads as the app dropping it (the round-5 lesson: every
    // silent no-op gets reported as breakage). Same for a live PTY whose agent
    // CLI has exited (round 6: codex self-updated, printed "Please restart
    // Codex", and quit — the shell underneath ate every "sent" message).
    // ...unless the pane can come back. A finished session whose conversation
    // the desktop still knows is not a dead end, and making the person leave
    // chat, find the row, tap resume, wait out the boot and then retype what
    // they had already written is four steps to get back to the message they
    // wrote in step zero. Sending IS the resume: the desktop respawns the
    // conversation, waits for it, clears the folder-trust gate on the way, and
    // delivers this as its first message (remote-bridge-resume-send).
    const resuming = Boolean(exited && canResume)
    const gate = resuming ? null : agentGateNotice(agent, exited)
    if (gate) {
      flashNotice(gate)
      return false
    }
    // A blocking TUI prompt owns the keyboard — a message typed now would rain
    // onto its option list. Answer it with the card's buttons instead.
    if (tuiPrompt) {
      flashNotice('Answer the prompt above first')
      return false
    }
    // A typed `/model opus` / `/effort high` is a control action, not a prompt —
    // apply it like the picker instead of sending it to the agent, which would
    // reply "type it at the prompt" (orca's classifyNativeChatSend routing).
    if (agent) {
      const cmd = parseModelCommand(agent, draft)
      if (cmd) {
        const submittedRevision = getDraftRevision()
        void applyModelChoice(cmd.model, cmd.effort).then((accepted) => {
          if (accepted) clearSubmittedDraft(submittedRevision)
        })
        return true
      }
    }
    const text = draft.trim()
    const images = readyAttachments
    if (!text && images.length === 0) return false
    if (uploadingCount > 0) return false
    const routeSteps = !resuming && liveQuestion ? chatAboutSteps(liveQuestion.questions) : null
    const submittedRevision = getDraftRevision()
    const finishSend = startSend()
    if (!finishSend) return false
    const nonce = crypto.randomUUID()
    if (images.length > 0) {
      echoPreviewsRef.current.set(
        `local:${nonce}`,
        images.map((a) => a.previewUrl),
      )
    }
    setEchoes((prev) => [...prev, makeEcho(text, afterSeq, nonce, Date.now(), images.length)])
    // The boot takes tens of seconds and prints nothing to chat while it runs,
    // so without this the echo just sits there and the send reads as dropped.
    if (resuming) flashNotice('Resuming the conversation — your message goes in first')
    // Sending is a statement that you're at the conversation's end.
    nearBottomRef.current = true
    setShowLatest(false)
    void convex.mutation(anyApi.remote.sendCommand, {
      token, sessionId,
      kind: resuming ? 'resumeSession' : 'sendChatMessage',
      payload: {
        text,
        images: images.map((image) => ({ storageId: image.storageId, mime: image.mime })),
        steer,
        ...(routeSteps ? { before: routeSteps } : {}),
      },
    }).then(() => {
      clearSubmittedDraft(submittedRevision)
      for (const image of images) forgetUpload(image.id)
      const sentIds = new Set(images.map((image) => image.id))
      setAttachments((current) => current.filter((image) => !sentIds.has(image.id)))
    }).catch((error: unknown) => {
      setEchoes((current) => current.filter((echo) => echo.message.uid !== `local:${nonce}`))
      echoPreviewsRef.current.delete(`local:${nonce}`)
      flashNotice(error instanceof Error ? error.message : 'Message was not sent — retry when connected')
    }).finally(finishSend)
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
    // one thing this picker must never do (see the flashes below).
    if (switchBusy) {
      flashNotice('Still switching — try again in a moment')
      return false
    }
    if (nativeStartBusy) {
      flashNotice('Native chat is starting')
      return false
    }
    if (nativeSnapshot) {
      if (nativeSnapshot.requests.length > 0) {
        flashNotice('Answer the request above first')
        return false
      }
      if (working) {
        flashNotice(nativePending ? 'Waiting for desktop confirmation' : 'Wait for the agent to finish')
        return false
      }
      const settings = {
        ...(model && model !== nativeSnapshot.settings.model ? { model } : {}),
        ...(effort && effort !== nativeSnapshot.settings.effort ? { effort } : {}),
      }
      if (!settings.model && !settings.effort) {
        flashNotice('Nothing to change')
        return false
      }
      const finishSwitch = startSwitch()
      if (!finishSwitch) return false
      try {
        await nativeChat.command({ kind: 'configure', settings })
        const applied = [
          settings.model
            ? modelOptionLabel(
                agent ?? nativeSnapshot.provider,
                'model',
                settings.model,
                nativePickerOptions,
              )
            : '',
          settings.effort
            ? modelOptionLabel(
                agent ?? nativeSnapshot.provider,
                'effort',
                settings.effort,
                nativePickerOptions,
              )
            : '',
        ].filter(Boolean).join(' · ')
        if (applied) flashNotice(`Switched to ${applied}`)
        return true
      } catch {
        flashNotice('Switch failed — tap the pill to retry')
        return false
      } finally {
        finishSwitch()
      }
    }
    // The popover can outlive the agent: the CLI dies while the picker is open
    // (or died moments before it opened, the status flip still in flight).
    // Driving the steps anyway would type "/model …" into a bare shell — one
    // more silent "the picker did nothing" report. Refuse with words instead.
    const gate = agentGateNotice(agent, exited)
    if (!agent || gate) {
      if (gate) flashNotice(gate)
      return false
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
      // model and effort in one flow, so a half without a known counterpart
      // can't be driven). SAY so: refusing in silence is indistinguishable
      // from the switch being dropped, which is exactly how a working picker
      // gets reported as broken.
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
      return false
    }
    const finishSwitch = startSwitch()
    if (!finishSwitch) {
      flashNotice('Still switching — try again in a moment')
      return false
    }
    try {
      await sendKeySteps(steps)
    } catch {
      // A dropped mutation (offline, expired token) left the pane silent and
      // the pill on its old label — same silence as a no-op, so say this one
      // too, and don't stamp an optimistic label for a switch that never went.
      flashNotice('Switch failed — tap the pill to retry')
      return false
    } finally {
      finishSwitch()
    }
    // Stamp what the mirror reported at apply time next to each field this
    // switch actually drove: the optimistic label yields to the mirror as soon
    // as it moves off this baseline (effectiveModelSelection). Only for the
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
    // reaches the transcript this view mirrors — so the pane flashes its own.
    // Claude used to flash nothing, so a switch from the phone landed with no
    // acknowledgement anywhere in the chat.
    const applied = [
      modelOptionLabel(agent, 'model', sentModel),
      modelOptionLabel(agent, 'effort', sentEffort),
    ]
      .filter(Boolean)
      .join(' · ')
    if (applied) flashNotice(`Switched to ${applied}`)
    return true
  }

  // Handed to the pickers instead of fresh closures: this pane re-renders on
  // every mirror push, and a picker re-rendering with it was repainting its
  // rows (and dropping the taps that landed mid-repaint) while an agent
  // streamed. Stable identity + memo means the pickers only ever repaint for
  // their own state.
  //
  // Selecting applies IMMEDIATELY (t3code-style — no Apply step). Claude's
  // /model and /effort are independent commands, so each control drives only
  // its own half; codex's TUI picker sets both in one flow, so either control
  // pairs its pick with the session's current value for the other half.
  const onSelectModel = useEventCallback((value: string) => {
    void applyModelChoice(
      value,
      !nativeActive && agent === 'codex' ? currentSelection.effort : undefined,
    )
  })
  const onSelectEffort = useEventCallback((value: string) => {
    void applyModelChoice(
      !nativeActive && agent === 'codex' ? currentSelection.model : undefined,
      value,
    )
  })
  const onPickerNotice = useEventCallback((text: string) => flashNotice(text))

  // What the pill and the sheet treat as the session's current model/effort:
  // the mirrored transcript truth, bridged by a locally-applied choice until
  // the mirror catches up.
  const currentSelection = nativeSnapshot
    ? nativeSnapshot.settings
    : agent
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
  // scrollTop by the delta so the button never moves under the finger (t3's
  // flushSync compensation, on a plain scroller).
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

  const startNativeChat = () => {
    if (nativeStartBusy || legacyWorking) return
    setNativeStartBusy(true)
    void nativeChat
      .command({ kind: 'start' })
      .catch((cause: unknown) => {
        flashNotice(cause instanceof Error ? cause.message : 'Could not start native chat')
      })
      .finally(() => setNativeStartBusy(false))
  }

  const nativeStatus =
    nativePending && nativeSnapshot?.status === 'idle'
      ? 'Waiting for desktop confirmation'
      : nativeSnapshot?.status === 'starting'
      ? 'Starting native chat…'
      : nativeSnapshot?.status === 'compacting'
        ? 'Compacting conversation…'
        : nativeSnapshot?.status === 'waiting'
          ? 'Waiting for your response'
          : null
  const nativeError =
    nativeSnapshot?.error ??
    nativeChat.error ??
    (nativeSnapshot?.status === 'error' ? 'Native chat stopped with an error.' : null)
  const nativeControlBlocked = Boolean(
    nativeSnapshot && (working || sendBusy || nativeSnapshot.requests.length > 0),
  )

  // ── Render ────────────────────────────────────────────────────────────────
  // The notice span renders even when the pill doesn't: refusals fired while
  // no agent runs (agentGateNotice) would otherwise flash into an unmounted
  // slot and never be seen — the exact silence they exist to break.
  const pickerGateNotice = agent && !nativeActive ? agentGateNotice(agent, exited) : null
  const modelPill = agent || switchNotice ? (
    <div className="flex min-w-0 items-center gap-1.5">
      {agent && (
        <>
          <ModelPickerControl
            agent={agent}
            currentModel={currentSelection.model}
            currentEffort={currentSelection.effort}
            busy={switchBusy}
            disabled={
              switchBusy ||
              nativeStartBusy ||
              !!liveQuestion ||
              !!tuiPrompt ||
              (!nativeActive && !!exited) ||
              nativeControlBlocked
            }
            gateNotice={pickerGateNotice}
            options={nativePickerOptions}
            onSelectModel={onSelectModel}
            onNotice={onPickerNotice}
          />
          <EffortControl
            agent={agent}
            currentEffort={currentSelection.effort}
            disabled={
              switchBusy ||
              nativeStartBusy ||
              !!liveQuestion ||
              !!tuiPrompt ||
              (!nativeActive && !!exited) ||
              nativeControlBlocked
            }
            gateNotice={pickerGateNotice}
            options={nativePickerOptions}
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
    // select-text re-enables copying inside the terminal viewport's select-none.
    <div className="relative h-full select-text" style={{ backgroundColor: terminalBg(color) }}>
      {/* One-finger native scroll only. No touch handlers at all, so the
          SessionRoll's two-finger gestures (registered on an ancestor) are
          never preempted here. The scroll-fade mask dissolves rows into the
          header instead of the old hard pt-12 lane;
          [overflow-anchor:none] keeps the browser out of our anchoring. */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="chat-timeline-scroll-fade slim-scrollbar h-full overflow-y-auto overscroll-contain px-3 [overflow-anchor:none] sm:px-5"
        style={{ paddingBottom: composerHeight + 12 }}
      >
        {/* A conversation shorter than the pane hangs off the BOTTOM, the way
            every chat does — top-anchored, two rows floated under the header
            with a screen of void beneath them and read as "my messages are
            missing". mt-auto rather than justify-end: with justify-end an
            overflowing column clips its own top rows in the scroller. */}
        <div className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col">
          {/* Top lane the fade mask dissolves rows into. Shorter now that the
              floating Chat ⌁ Term pill no longer sits in it. */}
          <div className="h-4" />
          <div className="mt-auto min-w-0">
            {/* Infinite-scroll sentinel: nearing the top auto-fetches the next
                earlier page; the visible affordances are just a spinner and, on
                error, a manual retry pill. */}
            {hasEarlier && !empty && <div ref={topSentinelRef} aria-hidden className="h-px" />}
            {hasEarlier && !empty && (loadingEarlier || earlierError) && (
              <div className="flex justify-center pb-3">
                {earlierError && !loadingEarlier ? (
                  <button
                    type="button"
                    onClick={() => void loadEarlier()}
                    className="rounded-full border border-border bg-surface-raised px-3 py-1 text-[11px] text-muted-foreground active:bg-surface-hover"
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
                  {nativeActive
                    ? 'Start the conversation below.'
                    : 'No conversation yet — this session\'s transcript hasn\'t produced messages.'}
                </p>
                <button
                  type="button"
                  onClick={onShowTerminal}
                  className="rounded-[var(--control-radius)] border border-border bg-surface-raised px-3 py-1.5 text-xs text-foreground active:bg-surface-hover"
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
            {nativeChat.snapshot === null && (legacyAgent === 'claude' || legacyAgent === 'codex') && (
              <div className="mb-3 rounded-xl border border-border bg-surface-raised p-3">
                <div className="text-sm font-medium text-foreground">Use native chat</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Future messages will use the provider directly. The terminal remains available as a separate shell.
                </p>
                <button
                  type="button"
                  disabled={legacyWorking || nativeStartBusy}
                  onClick={startNativeChat}
                  className="mt-3 rounded-[var(--control-radius)] bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                >
                  {nativeStartBusy ? 'Starting…' : 'Use native chat'}
                </button>
              </div>
            )}
            {nativeStatus && <div className="mb-3 text-center text-xs text-muted-foreground">{nativeStatus}</div>}
            {nativeError && (
              <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {nativeError}
              </div>
            )}
            {nativeSnapshot?.requests.map((request) => (
              <NativeChatRequestCard
                key={request.id}
                request={request}
                onRespond={(reply) => nativeChat.command({ kind: 'respond', reply })}
              />
            ))}
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
            className="chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors active:text-foreground"
          >
            <ArrowDown className="size-3.5" />
            Scroll to end
          </button>
        </div>
      )}

      {/* Composer — a glass overlay floating over the timeline (t3's layout);
          rows scroll behind it through the frosted surface. Replaces the
          AgentKeyBar as the input surface in chat mode (TerminalPane hides the
          key bar while this overlay is up); ActionBar and UsageStrip render
          below in TerminalPane's column as usual. */}
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
              // A blocking TUI prompt (folder trust, permission) outranks the
              // question form: the agent can't even reach a tool while it's up.
              tuiPrompt ? (
                <TuiPromptCard
                  key={tuiPromptKey ?? 'tui-prompt'}
                  prompt={tuiPrompt}
                  busy={tuiBusy}
                  onChoose={answerTuiPrompt}
                />
              ) : liveQuestion ? (
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
                      className="flex h-8 items-center justify-center rounded-full border border-border/70 px-2 text-sm text-muted-foreground active:bg-surface-hover disabled:opacity-40 sm:px-3"
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
                      <>
                        <span className="sm:hidden">Next</span>
                        <span className="hidden sm:inline">Next question</span>
                      </>
                    ) : formQuestions.length > 1 ? (
                      <>
                        <span className="sm:hidden">Submit</span>
                        <span className="hidden sm:inline">Submit answers</span>
                      </>
                    ) : (
                      <>
                        <span className="sm:hidden">Submit</span>
                        <span className="hidden sm:inline">Submit answer</span>
                      </>
                    )}
                  </button>
                </div>
              ) : nativeActive &&
                working &&
                !nativePending &&
                nativeSnapshot.requests.length === 0 ? (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => sendDraft({ steer: true })}
                  disabled={!canSend || sendBusy}
                  className="flex h-8 items-center justify-center rounded-full border border-amber-400/60 px-3 text-xs font-medium text-amber-400 active:bg-amber-400/10 disabled:opacity-40"
                >
                  Steer
                </button>
              ) : undefined
            }
            draft={questionComposerActive ? activeCustomAnswer : draft}
            onDraftChange={questionComposerActive ? setQuestionCustomAnswer : setDraft}
            onSend={() => sendDraft()}
            // No steer while a question form owns the TUI keyboard: that send
            // already routes through "Chat about this", and an Esc first would
            // dismiss the form the routing is aiming at.
            onSteer={
              liveQuestion ||
              tuiPrompt ||
              nativeStartBusy ||
              nativePending ||
              (nativeSnapshot?.requests.length ?? 0) > 0
                ? undefined
                : () => sendDraft({ steer: true })
            }
            canSend={
              canSend &&
              !sendBusy &&
              !nativeStartBusy &&
              !nativePending &&
              (nativeSnapshot?.requests.length ?? 0) === 0
            }
            working={working || sendBusy || nativeStartBusy}
            onInterrupt={interrupt}
            attachments={attachments}
            onPickFiles={() => fileInputRef.current?.click()}
            onRemoveAttachment={removeAttachment}
            attachEnabled={attachments.length < MAX_ATTACHMENTS}
            dictation={{
              listening: dictation.isDictating,
              processing: dictation.isProcessing,
              error: dictation.error,
            }}
            micProps={{
              'aria-pressed': dictation.isDictating,
              disabled: dictation.isProcessing,
              onContextMenu: (e) => e.preventDefault(),
              onPointerDown: (e) => {
                e.preventDefault()
                // preventDefault keeps an OPEN keyboard up; with the keyboard
                // already hidden it instead leaves the composer focused, which
                // is what made Android pop the keyboard back up on this tap.
                releaseHiddenKeyboardFocus()
                dictation.start()
              },
              onPointerUp: dictation.stop,
              onPointerLeave: dictation.stop,
              onPointerCancel: dictation.stop,
            }}
            modelPill={modelPill}
            contextRatio={contextRatio}
            onShowTerminal={onShowTerminal}
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
              // Steer at the keyboard: ⌘⏎ / Ctrl+⏎ interrupts the turn and sends
              // now. Checked before the plain-Enter branch, which would other-
              // wise swallow it (metaKey says nothing about shiftKey).
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !liveQuestion && !tuiPrompt) {
                e.preventDefault()
                const el = e.currentTarget
                if (sendDraft({ steer: true })) dismissSoftKeyboard(el)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                const el = e.currentTarget
                // t3code: while a drivable form is pending, Enter walks the
                // form (Next question / Submit) instead of sending a message —
                // the keyboard only drops on the real final submit.
                if (formDrivable) {
                  const willSubmit = isLastQuestion && questionFormComplete
                  advanceQuestionForm()
                  if (willSubmit) dismissSoftKeyboard(el)
                  return
                }
                if (sendDraft()) dismissSoftKeyboard(el)
              }
            }}
            placeholder={
              (nativeStartBusy
                ? 'Native chat is starting…'
                : nativePending && nativeSnapshot?.status === 'idle'
                ? 'Waiting for desktop confirmation'
                : nativeSnapshot?.status === 'starting'
                ? 'Native chat is starting…'
                : nativeSnapshot?.status === 'compacting'
                  ? 'Conversation is compacting…'
                  : nativeSnapshot?.requests.length
                    ? 'Answer the request above first'
                    : null) ??
              (exited && canResume ? null : agentGateNotice(agent, exited)) ??
              (exited
                ? 'Send to resume this conversation'
                : null) ??
              (tuiPrompt
                ? 'Choose an option above'
                : questionComposerActive
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
