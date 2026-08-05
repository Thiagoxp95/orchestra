'use client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { ArrowDown, ChevronUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  forgetUpload,
  loadComposer,
  parkComposer,
  patchParkedAttachment,
  pendingUpload,
  rememberUpload,
  type Attachment,
  type AttachmentPatch,
} from '../lib/composer-draft'
import { useDictation } from '../hooks/useDictation'
import { terminalBg } from '../lib/terminal-theme'
import { QuestionCard } from './QuestionCard'
import { DynamicIcon } from './DynamicIcon'
import { ModelSheet, modelOptionLabel } from './ModelSheet'
import { Composer } from './chat/Composer'
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
import {
  adoptEchoPreviews,
  buildClaudeModelKeySteps,
  buildCodexModelKeySteps,
  chatAboutSteps,
  cutAtReset,
  effectiveModelSelection,
  foldForDisplay,
  makeEcho,
  mergeMessages,
  pruneEchoes,
  type AgentKind,
  type ChatBlock,
  type ChatMessage,
  type DisplayBlock,
  type KeyStep,
  type PendingEcho,
  type SeqChatMessage,
} from '../lib/chat-messages'

type QuestionBlock = Extract<DisplayBlock, { kind: 'question' }>

// One backfill page. Matches the desktop tailer's first-attach window closely
// enough that the first page usually IS the whole retained conversation.
const PAGE_SIZE = 60

// How close to the end still counts as "reading the live tail". Generous enough
// that the rubber-band settle after a flick doesn't count as scrolling away.
const NEAR_BOTTOM_PX = 80

// The Enter that submits a paste must trail the paste itself: sent in the same
// write, the TUI still has the bracketed-paste terminator in its input queue and
// swallows the CR as paste body. This pacing is the Orca-proven recipe.
const CR_DELAY_MS = 150

// Attachment chips get unwieldy past this; the agent rarely needs more shots.
const MAX_ATTACHMENTS = 4

// Scroller bottom inset before the composer height is first measured — roughly
// one composer of clearance so the initial paint doesn't hide the tail.
const COMPOSER_FALLBACK_PX = 120

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
    case 'question':
      return 'pb-4'
    case 'assistant':
      return row.terminal ? 'pb-4' : 'pb-2'
    case 'work':
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
  working,
  agent,
  mirroredModel,
  mirroredEffort,
  contextTokens,
  contextWindow,
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
  /** Flip the page to the terminal view — the empty state's escape hatch for plain-shell sessions. */
  onShowTerminal: () => void
}) {
  const convex = useConvex()

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
  const [echoes, setEchoes] = useState<PendingEcho[]>([])
  const [showLatest, setShowLatest] = useState(false)
  // Composer contents outlive this pane: it is remounted on every foreground
  // (page.tsx keys TerminalPane by the resync nonce), so both halves are
  // hydrated from the park rather than starting empty. See lib/composer-draft.
  const [draft, setDraft] = useState(() => loadComposer(sessionId).draft)
  const [attachments, setAttachments] = useState<Attachment[]>(
    () => loadComposer(sessionId).attachments,
  )
  // Timeline expansion state — opened turn folds and "+N previous tool calls"
  // groups. Local by design: lost on remount, like t3 (reload resets folds).
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [switchBusy, setSwitchBusy] = useState(false)
  // Codex prints its "Model changed" only in the terminal, so the pane flashes
  // its own confirmation; claude's slash commands echo back through the
  // transcript and need none.
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
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

  // Dictation transcripts land in the composer, not just the PTY: the desktop
  // types the text into the TUI input line (the terminal view's flow), which is
  // invisible from here — so mirror it into the draft where the user is looking,
  // editable before sending. sendDraft's leading Ctrl-U clears the TUI's copy.
  const dictation = useDictation(token, sessionId, (text) => {
    setDraft((d) => (d ? `${d.endsWith(' ') ? d : `${d} `}${text}` : text))
  })

  // ── Backfill: one-shot newest page, then let the live tail take over ──────
  useEffect(() => {
    let cancelled = false
    void convex
      .query(anyApi.remote.getMessagesBefore, {
        token,
        sessionId,
        beforeSeq: Number.MAX_SAFE_INTEGER,
        limit: PAGE_SIZE,
      })
      .then((rows) => {
        if (cancelled) return
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
        if (!cancelled) setSeeded(true)
      })
    return () => {
      cancelled = true
    }
  }, [convex, token, sessionId])

  // ── Live tail: subscribe above the highest merged seq ─────────────────────
  const live = useQuery(
    anyApi.remote.getMessages,
    seeded ? { token, sessionId, afterSeq } : 'skip',
  ) as WireMessage[] | undefined

  // The Convex subscription surfaces as a value; folding it into the held list
  // is the "subscribe to an external store" case (same shape as useDictation's
  // result effect).
  useEffect(() => {
    if (!live || live.length === 0) return
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
  }, [live])

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
    if (loadingEarlier || lowest === null) return
    setLoadingEarlier(true)
    try {
      const rows = (await convex.query(anyApi.remote.getMessagesBefore, {
        token,
        sessionId,
        beforeSeq: lowest,
        limit: PAGE_SIZE,
      })) as WireMessage[] | null
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
      setMessages((prev) => mergeMessages(prev, page))
      setHasEarlier(page.length >= PAGE_SIZE)
      setEarlierError(false)
    } catch {
      // Keep hasEarlier so the retry pill renders; the auto-loader stands down
      // until the reader taps it (no hammering a failing backend on scroll).
      setEarlierError(true)
    }
    setLoadingEarlier(false)
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
    if (!seeded || !hasEarlier || loadingEarlier || earlierError) return
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
  }, [seeded, hasEarlier, loadingEarlier, earlierError])

  // ── Display model ─────────────────────────────────────────────────────────
  // cutAtReset first: a reset marker means the desktop swapped this session to
  // a different conversation and cleared the stored rows — everything held
  // before the marker is the old conversation and must not render above the
  // new one. Echoes sit after the held rows, so a cut never drops a pending
  // send.
  // Memoized: a composer keystroke re-renders the pane, and re-deriving up to
  // 400 rows (fold + timeline) per keypress is waste the old pane also paid —
  // don't inherit it.
  const { display, rows, liveQuestion } = useMemo(() => {
    const display = foldForDisplay(cutAtReset([...messages, ...echoes.map((e) => e.message)]))
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
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId,
      kind: 'write',
      payload: { data },
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
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
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

  // Park the composer on every change, not from an unmount cleanup: iOS can
  // discard the whole document without ever running one.
  useEffect(() => {
    parkComposer(sessionId, { draft, attachments })
  }, [sessionId, draft, attachments])

  const readyAttachments = attachments.filter((a) => a.status === 'ready' && a.storageId)
  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length
  const canSend = (draft.trim().length > 0 || readyAttachments.length > 0) && uploadingCount === 0

  const sendDraft = () => {
    const text = draft.trim()
    const images = readyAttachments
    if (!text && images.length === 0) return
    if (uploadingCount > 0) return
    // Ctrl-U first: the TUI's input line may already hold text this composer
    // can't see — most commonly a dictation transcript the desktop typed there
    // (mirrored into this draft), or something typed at the desk. Sending
    // without clearing would submit both copies glued together. Then bracketed
    // paste: the TUI takes the whole message as one paste instead of
    // interpreting newlines as submits. The CR that actually submits follows
    // on its own delayed write — see CR_DELAY_MS. With attachments the whole
    // recipe moves desktop-side (sendChatMessage) so the downloaded paths ride
    // inside the same paste as the text.
    const dispatch =
      images.length > 0
        ? () => {
            void convex.mutation(anyApi.remote.sendCommand, {
              token,
              sessionId,
              kind: 'sendChatMessage',
              payload: {
                text,
                images: images.map((a) => ({ storageId: a.storageId, mime: a.mime })),
              },
            })
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
    if (!agent || switchBusy) return
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
      // Nothing to change (or an incomplete codex pair). Close, but SAY so:
      // closing in silence is indistinguishable from the switch being dropped,
      // which is exactly how a working picker gets reported as broken.
      setModelSheetOpen(false)
      const current = [
        modelOptionLabel(agent, 'model', currentSelection.model),
        modelOptionLabel(agent, 'effort', currentSelection.effort),
      ]
        .filter(Boolean)
        .join(' · ')
      flashNotice(
        agent === 'codex' && !(model && effort)
          ? 'Pick both a model and an effort'
          : current
            ? `Already on ${current}`
            : 'Nothing to change',
      )
      return
    }
    setModelSheetOpen(false)
    setSwitchBusy(true)
    try {
      await sendKeySteps(steps)
    } catch {
      // A dropped mutation (offline, expired token) left the pane silent and
      // the pill on its old label — same silence as a no-op, so say this one
      // too, and don't stamp an optimistic label for a switch that never went.
      flashNotice('Switch failed — tap the pill to retry')
      return
    } finally {
      setSwitchBusy(false)
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
  }

  // What the pill and the sheet treat as the session's current model/effort:
  // the mirrored transcript truth, bridged by a locally-applied choice until
  // the mirror catches up.
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

  // ── Render ────────────────────────────────────────────────────────────────
  const modelPill = agent ? (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setModelSheetOpen(true)}
        disabled={switchBusy || !!liveQuestion}
        className="flex h-8 items-center gap-1.5 rounded-full border border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground active:bg-surface-hover disabled:opacity-50"
      >
        <DynamicIcon name={agent === 'claude' ? '__claude__' : '__openai__'} size={12} />
        {switchBusy ? (
          <span className="flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Switching…
          </span>
        ) : currentSelection.model || currentSelection.effort ? (
          <span className="max-w-40 truncate">
            {[
              modelOptionLabel(agent, 'model', currentSelection.model),
              modelOptionLabel(agent, 'effort', currentSelection.effort),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : (
          'Model · Effort'
        )}
        <ChevronUp className="size-3" />
      </button>
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
          never preempted here. The scroll-fade mask dissolves rows under the
          page's floating Chat/Term pill instead of the old hard pt-12 lane;
          [overflow-anchor:none] keeps the browser out of our anchoring. */}
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
                No conversation yet — this session&apos;s transcript hasn&apos;t produced messages.
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
                  <QuestionCard
                    block={row.block}
                    interactive={row.block === liveQuestion}
                    onSendKeys={sendKeySteps}
                  />
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
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            draft={draft}
            onDraftChange={setDraft}
            onSend={sendDraft}
            canSend={canSend}
            working={working}
            onInterrupt={() => sendWrite('\x1b')}
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
                dictation.start()
              },
              onPointerUp: dictation.stop,
              onPointerLeave: dictation.stop,
              onPointerCancel: dictation.stop,
            }}
            modelPill={modelPill}
            contextRatio={contextRatio}
            onTextareaKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendDraft()
              }
            }}
            placeholder="Message the agent"
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
      {agent && modelSheetOpen && (
        <ModelSheet
          agent={agent}
          initial={currentSelection}
          onApply={(model, effort) => void applyModelChoice(model, effort)}
          onClose={() => setModelSheetOpen(false)}
        />
      )}
    </div>
  )
}
