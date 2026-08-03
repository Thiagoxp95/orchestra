'use client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { createElement, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Mic,
  Plus,
  Search,
  SquarePen,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDictation } from '../hooks/useDictation'
import { terminalBg } from '../lib/terminal-theme'
import { QuestionCard } from './QuestionCard'
import { DynamicIcon } from './DynamicIcon'
import { ModelSheet, modelOptionLabel } from './ModelSheet'
import {
  adoptEchoPreviews,
  buildClaudeModelKeySteps,
  buildCodexModelKeySteps,
  chatAboutKey,
  cutAtReset,
  effectiveModelSelection,
  foldForDisplay,
  groupWork,
  makeEcho,
  mergeMessages,
  pruneEchoes,
  splitUserImageTokens,
  type AgentKind,
  type ChatBlock,
  type ChatMessage,
  type DisplayBlock,
  type DisplayItem,
  type DisplayRow,
  type KeyStep,
  type PendingEcho,
  type SeqChatMessage,
  type ToolResultDisplay,
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

// Composer send while an AskUserQuestion form is up: the "Chat about this"
// digit dismisses the form first, and the paste must wait out the TUI's
// form→composer redraw or it rains onto the option list.
const FORM_DISMISS_DELAY_MS = 450

// Conversation pauses of this length get a date divider; anything shorter is
// the same sitting and a timestamp would just be clutter.
const DIVIDER_GAP_MS = 6 * 60 * 60 * 1000

// Composer textarea grows with the draft up to ~4 rows, then scrolls inside.
const MAX_TEXTAREA_PX = 104

// Attachment chips get unwieldy past this; the agent rarely needs more shots.
const MAX_ATTACHMENTS = 4

/** One picked image riding the composer until send. previewUrl is an object URL. */
type Attachment = {
  id: string
  previewUrl: string
  mime: string
  status: 'uploading' | 'ready' | 'error'
  storageId?: string
}

/** The last model/effort this pane applied to a session — display state only.
 *  baseModel/baseEffort are what the mirror reported at apply time, so the
 *  applied choice can yield to the mirror once it moves (see
 *  effectiveModelSelection). */
type ModelChoice = { model?: string; effort?: string; baseModel?: string; baseEffort?: string }

function modelChoiceKey(sessionId: string): string {
  return `orchestra.agentModel.${sessionId}`
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
  const [echoes, setEchoes] = useState<PendingEcho[]>([])
  const [showLatest, setShowLatest] = useState(false)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Folded work groups the reader has opened; keyed by the group's stable uid.
  const [expandedWork, setExpandedWork] = useState<Set<string>>(() => new Set())
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [switchBusy, setSwitchBusy] = useState(false)
  // Codex prints its "Model changed" only in the terminal, so the pane flashes
  // its own confirmation; claude's slash commands echo back through the
  // transcript and need none.
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const [modelChoice, setModelChoice] = useState<ModelChoice>(() =>
    typeof window === 'undefined' ? {} : loadModelChoice(sessionId),
  )

  const scrollerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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

  // Dictation transcripts land in the composer, not just the PTY: the desktop
  // types the text into the TUI input line (the terminal view's flow), which is
  // invisible from here — so mirror it into the draft where the user is looking,
  // editable before sending. sendDraft's leading Ctrl-U clears the TUI's copy.
  const dictation = useDictation(token, sessionId, (text) => {
    setDraft((d) => (d ? `${d.endsWith(' ') ? d : `${d} `}${text}` : text))
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_PX)}px`
    })
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
  // is the "subscribe to an external store" case the set-state-in-effect rule
  // exempts but can't see through useQuery (same shape as useDictation's
  // result effect).
  /* eslint-disable react-hooks/set-state-in-effect */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Stick to bottom ───────────────────────────────────────────────────────
  // Native scrolling is the whole point of this pane, so following the tail is
  // done by pinning scrollTop after content grows — but only for a reader who
  // was at the bottom; anyone reading back gets a "↓ latest" pill instead of a
  // yank. The rAF re-pin covers late layout (fonts, the working dots mounting).
  /* eslint-disable react-hooks/set-state-in-effect */
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
  /* eslint-enable react-hooks/set-state-in-effect */

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    nearBottomRef.current = nearBottom
    if (nearBottom) setShowLatest(false)
  }

  const jumpToLatest = () => {
    nearBottomRef.current = true
    setShowLatest(false)
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
  }

  // ── Load earlier: one-shot page below the lowest held seq ─────────────────
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
    } catch {
      // Leave hasEarlier set so the pill stays and the tap can be retried.
    }
    setLoadingEarlier(false)
  }

  // ── Display model ─────────────────────────────────────────────────────────
  // cutAtReset first: a reset marker means the desktop swapped this session to
  // a different conversation and cleared the stored rows — everything held
  // before the marker is the old conversation and must not render above the
  // new one. Echoes sit after the held rows, so a cut never drops a pending
  // send.
  const display = foldForDisplay(cutAtReset([...messages, ...echoes.map((e) => e.message)]))
  const rows = groupWork(display, working)
  const empty = seeded && display.length === 0

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

  // ── Sending ───────────────────────────────────────────────────────────────
  const sendWrite = (data: string) => {
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId,
      kind: 'write',
      payload: { data },
    })
  }

  // The QuestionCard's answer driver: each step is its own awaited write so
  // the TUI sees discrete keypresses in order, with the pacing the key
  // protocol asks for (a digit that advances the form needs the redraw to
  // finish before the next digit lands on the RIGHT question).
  const sendKeySteps = async (steps: KeyStep[]) => {
    for (const step of steps) {
      await convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId,
        kind: 'write',
        payload: { data: step.data },
      })
      if (step.delayAfterMs > 0) await new Promise((r) => setTimeout(r, step.delayAfterMs))
    }
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  // Each picked image uploads to Convex storage immediately (chip shows a
  // spinner until its storageId lands); send then references the finished
  // uploads in one `sendChatMessage` command, and the desktop bridge downloads
  // them and types "<path> <path> <text>" as a single submitted paste.
  const uploadAttachment = async (id: string, file: File) => {
    try {
      const mime = file.type || 'image/png'
      const url = (await convex.mutation(anyApi.remote.generateUploadUrl, { token })) as string
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': mime }, body: file })
      if (!res.ok) throw new Error(`upload failed (${res.status})`)
      const { storageId } = (await res.json()) as { storageId: string }
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: 'ready' as const, storageId } : a)),
      )
    } catch {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: 'error' as const } : a)),
      )
    }
  }

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
      void uploadAttachment(id, file)
    }
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Allow re-picking the same screenshot back-to-back.
    e.target.value = ''
    addFiles(files)
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

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
    // keystrokes onto the option list.
    const routeKey = liveQuestion ? chatAboutKey(liveQuestion.questions) : null
    if (routeKey) {
      sendWrite(routeKey)
      setTimeout(dispatch, FORM_DISMISS_DELAY_MS)
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
    setAttachments((prev) => prev.filter((a) => a.status === 'error'))
    const ta = textareaRef.current
    if (ta) ta.style.height = 'auto'
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
    const steps =
      agent === 'claude'
        ? buildClaudeModelKeySteps(model, effort)
        : model && effort
          ? buildCodexModelKeySteps(model, effort)
          : null
    if (!steps) return
    setModelSheetOpen(false)
    setSwitchBusy(true)
    try {
      await sendKeySteps(steps)
    } finally {
      setSwitchBusy(false)
    }
    // Stamp what the mirror reported at apply time next to each applied field:
    // the optimistic label yields to the mirror as soon as it moves off this
    // baseline (effectiveModelSelection). Only for the fields applied now — an
    // untouched field keeps its earlier baseline.
    const next: ModelChoice = {
      ...modelChoice,
      ...(model ? { model, baseModel: mirroredModel } : {}),
      ...(effort ? { effort, baseEffort: mirroredEffort } : {}),
    }
    setModelChoice(next)
    try {
      window.localStorage.setItem(modelChoiceKey(sessionId), JSON.stringify(next))
    } catch {
      // Storage full/blocked — the picker just forgets the label.
    }
    if (agent === 'codex') {
      flashNotice(
        `Switched to ${modelOptionLabel(agent, 'model', model)} · ${modelOptionLabel(agent, 'effort', effort)}`,
      )
    }
  }

  // What the pill and the sheet treat as the session's current model/effort:
  // the mirrored transcript truth, bridged by a locally-applied choice until
  // the mirror catches up.
  const currentSelection = agent
    ? effectiveModelSelection(agent, modelChoice, mirroredModel, mirroredEffort)
    : {}

  const onDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value)
    const ta = e.currentTarget
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_PX)}px`
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    // select-text re-enables copying inside the terminal viewport's select-none.
    <div className="flex h-full select-text flex-col" style={{ backgroundColor: terminalBg(color) }}>
      <div className="relative min-h-0 flex-1">
        {/* One-finger native scroll only. No touch handlers at all, so the
            SessionRoll's two-finger gestures (registered on an ancestor) are
            never preempted here. pt-12 keeps the first row clear of the page's
            floating Chat/Term pill. */}
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto overscroll-contain px-3 pb-3 pt-12"
        >
          {hasEarlier && !empty && (
            <div className="flex justify-center pb-3">
              <button
                type="button"
                onClick={() => void loadEarlier()}
                disabled={loadingEarlier}
                className="rounded-full border border-border bg-foreground/10 px-3 py-1 text-[11px] text-muted-foreground active:bg-foreground/20 disabled:opacity-50"
              >
                {loadingEarlier ? 'Loading…' : 'Load earlier'}
              </button>
            </div>
          )}
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                No conversation yet — this session&apos;s transcript hasn&apos;t produced messages.
              </p>
              <button
                type="button"
                onClick={onShowTerminal}
                className="rounded-md border border-border bg-foreground/10 px-3 py-1.5 text-xs text-foreground active:bg-foreground/20"
              >
                Open terminal
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((row, i) => {
                const prevRow = rows[i - 1]
                const prevItem = prevRow
                  ? prevRow.kind === 'item'
                    ? prevRow.item
                    : prevRow.items[prevRow.items.length - 1]
                  : undefined
                if (row.kind === 'work') {
                  return (
                    <WorkGroupRow
                      key={row.uid}
                      group={row}
                      expanded={expandedWork.has(row.uid)}
                      onToggle={() =>
                        setExpandedWork((prev) => {
                          const next = new Set(prev)
                          if (next.has(row.uid)) next.delete(row.uid)
                          else next.add(row.uid)
                          return next
                        })
                      }
                      working={working && row.live}
                      previews={echoPreviewsRef.current}
                      liveQuestion={liveQuestion}
                      onSendKeys={sendKeySteps}
                    />
                  )
                }
                return (
                  <Fragment key={row.item.uid}>
                    <DayDivider prev={prevItem} item={row.item} />
                    <MessageItem
                      item={row.item}
                      liveQuestion={liveQuestion}
                      onSendKeys={sendKeySteps}
                      working={working && i >= rows.length - 3}
                      previews={echoPreviewsRef.current}
                    />
                  </Fragment>
                )
              })}
              {working && <WorkingDots />}
            </div>
          )}
        </div>
        {showLatest && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background/80 px-3 py-1.5 text-xs text-foreground shadow-md backdrop-blur"
          >
            <ArrowDown className="size-3.5" />
            latest
          </button>
        )}
      </div>

      {/* Composer — replaces the AgentKeyBar as the input surface in chat mode
          (TerminalPane hides the key bar while this overlay is up); ActionBar
          and UsageStrip render below it in TerminalPane's column as usual. */}
      <div className="border-t border-border bg-sidebar p-2">
        {(dictation.isDictating || dictation.isProcessing || dictation.error) && (
          <div className="pb-1.5 text-xs text-muted-foreground">
            {dictation.error ? (
              <span className="text-red-400">🎤 {dictation.error}</span>
            ) : dictation.isProcessing ? (
              <span className="animate-pulse">✍️ Transcribing…</span>
            ) : (
              <span className="animate-pulse">🎤 Listening…</span>
            )}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-background"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- object URL preview */}
                <img src={a.previewUrl} alt="" className="h-full w-full object-cover" />
                {a.status === 'uploading' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Loader2 className="size-4 animate-spin text-white" />
                  </div>
                )}
                {a.status === 'error' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-red-900/60 text-[10px] font-medium text-white">
                    failed
                  </div>
                )}
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => removeAttachment(a.id)}
                  className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          {/* Esc = interrupt. Tinted while the agent works, since that is when
              you reach for it. */}
          <button
            type="button"
            aria-label="Interrupt (Escape)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendWrite('\x1b')}
            className={cn(
              'h-9 shrink-0 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground active:bg-accent',
              working && 'border-red-500/50 text-red-400',
            )}
          >
            Esc
          </button>
          {/* text-[16px] is load-bearing: iOS Safari auto-zooms any focused
              control whose font is under 16px, and appViewport deliberately
              bails out at scale > 1.01 (shrinking the shell would fight the
              zoom) — so a 14px composer could wedge the whole layout with the
              composer stuck behind the keyboard. leading-5 pulls the row back
              to the height the old text-sm had, despite the bigger glyphs. */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendDraft()
              }
            }}
            placeholder="Message the agent"
            className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-[16px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
            style={{ maxHeight: MAX_TEXTAREA_PX }}
          />
          {/* "+" = attach images. Opens the photo picker; picked shots upload
              immediately and ride the next send as typed paths. */}
          <button
            type="button"
            aria-label="Attach image"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground active:bg-accent disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPickFiles}
          />
          {/* Hold-to-talk, same contract as the AgentKeyBar mic (the desktop
              TYPES the transcript into the agent's input; no auto-Enter). */}
          <button
            type="button"
            aria-label="Hold to talk"
            aria-pressed={dictation.isDictating}
            disabled={dictation.isProcessing}
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              e.preventDefault()
              dictation.start()
            }}
            onPointerUp={dictation.stop}
            onPointerLeave={dictation.stop}
            onPointerCancel={dictation.stop}
            className={cn(
              'flex size-9 shrink-0 touch-none select-none items-center justify-center rounded-full bg-red-600 text-white active:bg-red-700',
              dictation.isDictating && 'animate-pulse bg-red-700',
              dictation.isProcessing && 'bg-red-900 opacity-80',
            )}
          >
            <Mic className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Send"
            disabled={!canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={sendDraft}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
        {/* Model/effort pill — agent sessions only. Switching drives the live
            TUI over the keystroke pipe (claude: /model + /effort commands;
            codex: its /model digit picker), so it's disabled while a question
            form owns the TUI's keyboard. */}
        {agent && (
          <div className="flex items-center justify-between pt-1.5">
            <button
              type="button"
              onClick={() => setModelSheetOpen(true)}
              disabled={switchBusy || !!liveQuestion}
              className="flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground active:bg-accent disabled:opacity-50"
            >
              <DynamicIcon name={agent === 'claude' ? '__claude__' : '__openai__'} size={12} />
              {switchBusy ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> Switching…
                </span>
              ) : currentSelection.model || currentSelection.effort ? (
                [
                  modelOptionLabel(agent, 'model', currentSelection.model),
                  modelOptionLabel(agent, 'effort', currentSelection.effort),
                ]
                  .filter(Boolean)
                  .join(' · ')
              ) : (
                'Model · Effort'
              )}
              <ChevronUp className="size-3" />
            </button>
            {switchNotice && (
              <span className="truncate pl-2 text-[11px] text-muted-foreground">{switchNotice}</span>
            )}
          </div>
        )}
      </div>
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

// ── Renderers ────────────────────────────────────────────────────────────────
// All surfaces are foreground-alpha overlays (bg-foreground/10) rather than
// bg-muted: the workspace tint (workspace-color.ts chromeVars) rewrites
// --foreground/--muted-foreground per workspace but not --muted, so a muted
// surface would stay default-dark on a tinted (possibly light) background
// while its text re-tinted — foreground-alpha stays legible on every tint.

function DayDivider({ prev, item }: { prev?: DisplayItem; item: DisplayItem }) {
  if (prev?.ts == null || item.ts == null || item.ts - prev.ts <= DIVIDER_GAP_MS) return null
  return (
    <div className="py-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground">
      {new Date(item.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
    </div>
  )
}

function MessageItem({
  item,
  liveQuestion,
  onSendKeys,
  working = false,
  previews,
}: {
  item: DisplayItem
  /** The one pending question block that is safely drivable right now, if any. */
  liveQuestion: QuestionBlock | null
  onSendKeys: (steps: KeyStep[]) => Promise<void>
  /** The turn is running AND this row is near the tail — unresolved tools spin. */
  working?: boolean
  /** Object-URL thumbnails for optimistic echoes, keyed by echo uid. */
  previews?: Map<string, string[]>
}) {
  if (item.role === 'system') {
    return <div className="py-0.5 text-center text-[11px] text-muted-foreground">{plainText(item)}</div>
  }
  if (item.role === 'user') {
    // A `local:` uid is our own optimistic echo, still waiting for the
    // transcript's copy to come back — rendered dimmed until it does.
    const pending = item.uid.startsWith('local:')
    const thumbs = previews?.get(item.uid)
    const raw = item.blocks
      .filter((b): b is Extract<DisplayBlock, { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text)
      .join('\n')
    // Typed image paths (and claude's "[Image #N]" placeholders) read as noise
    // in a bubble — swap them for a compact chip, like the image blocks.
    const { text, imageCount: tokenCount } = splitUserImageTokens(raw)
    const imageCount = tokenCount + item.blocks.filter((b) => b.kind === 'image').length
    return (
      <div className={cn('flex justify-end', pending && 'opacity-70')}>
        <div className="max-w-[85%] rounded-2xl bg-foreground/10 px-3 py-2 text-sm text-foreground">
          {thumbs && thumbs.length > 0 ? (
            <div className={cn('flex flex-wrap justify-end gap-1.5', text && 'mb-1.5')}>
              {thumbs.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- object URL preview
                <img key={i} src={src} alt="" className="size-20 rounded-lg object-cover" />
              ))}
            </div>
          ) : imageCount > 0 ? (
            <div
              className={cn(
                'flex items-center justify-end gap-1 text-xs text-muted-foreground',
                text && 'mb-1',
              )}
            >
              <ImageIcon className="size-3.5" />
              {imageCount === 1 ? 'image' : `${imageCount} images`}
            </div>
          ) : null}
          {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
        </div>
      </div>
    )
  }
  // assistant, and standalone tool leftovers.
  return (
    <div className="space-y-1.5">
      {item.blocks.map((b, i) => (
        <BlockView
          key={i}
          block={b}
          interactive={b === liveQuestion}
          onSendKeys={onSendKeys}
          working={working}
        />
      ))}
    </div>
  )
}

/** System content flattened to text; images become a small marker. */
function plainText(item: DisplayItem): string {
  return item.blocks
    .map((b) => (b.kind === 'text' ? b.text : b.kind === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** A folded run of tool/thinking rows: "Worked · N steps", expandable. */
function WorkGroupRow({
  group,
  expanded,
  onToggle,
  working,
  previews,
  liveQuestion,
  onSendKeys,
}: {
  group: Extract<DisplayRow, { kind: 'work' }>
  expanded: boolean
  onToggle: () => void
  working: boolean
  previews: Map<string, string[]>
  liveQuestion: QuestionBlock | null
  onSendKeys: (steps: KeyStep[]) => Promise<void>
}) {
  const first = group.items[0]?.ts
  const last = group.items[group.items.length - 1]?.ts
  const durMs = first != null && last != null ? last - first : 0
  const dur =
    durMs >= 3000 ? (durMs < 60_000 ? `${Math.round(durMs / 1000)}s` : `${Math.round(durMs / 60_000)}m`) : null
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Chevron className="size-3.5 shrink-0" />
        {group.live ? (
          <span>{group.steps} earlier steps</span>
        ) : (
          <span className="flex items-center gap-1">
            <Check className="size-3" />
            Worked · {group.steps} steps
            {dur ? ` · ${dur}` : ''}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5 border-l-2 border-border pl-2">
          {group.items.map((item) => (
            <MessageItem
              key={item.uid}
              item={item}
              liveQuestion={liveQuestion}
              onSendKeys={onSendKeys}
              working={working}
              previews={previews}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BlockView({
  block,
  interactive,
  onSendKeys,
  working = false,
}: {
  block: DisplayBlock
  interactive: boolean
  onSendKeys: (steps: KeyStep[]) => Promise<void>
  working?: boolean
}) {
  switch (block.kind) {
    case 'text':
      return <TextBlock text={block.text} />
    case 'thinking':
      return <ThinkingBlock text={block.text} />
    case 'question':
      return <QuestionCard block={block} interactive={interactive} onSendKeys={onSendKeys} />
    case 'tool':
      return <ToolRow name={block.name} input={block.input} result={block.result} working={working} />
    case 'toolResult':
      // An orphan result (its call fell off the retention window): same row
      // shape as a paired call, with the output itself standing in for both.
      return (
        <ToolRow
          name="result"
          input={block.output}
          result={{ output: block.output, isError: block.isError }}
        />
      )
    case 'image':
      return (
        <div className="flex items-center gap-1 text-xs italic text-muted-foreground">
          <ImageIcon className="size-3.5" />
          {block.alt ?? 'image'}
        </div>
      )
    case 'reset':
      // A conversation-cut marker; cutAtReset drops it before display, so this
      // only exists to keep the switch total.
      return null
  }
}

/**
 * Assistant prose rendered as markdown. The agent writes markdown-formatted
 * text (headings, bold, lists, fences), so raw glyphs on screen read as a bug.
 * remark-breaks keeps single newlines as line breaks — transcript text mixes
 * markdown paragraphs with hard-wrapped plain lines, and collapsing the latter
 * mangles them. Raw HTML is NOT rendered (react-markdown skips it by default),
 * so transcript content can't inject markup. Headings are deliberately modest:
 * a phone-width chat bubble has no room for display sizes.
 */
function TextBlock({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-sm leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: (p) => <p className="my-2 break-words" {...p} />,
          h1: (p) => <h1 className="mb-1.5 mt-4 text-base font-semibold" {...p} />,
          h2: (p) => <h2 className="mb-1.5 mt-4 text-base font-semibold" {...p} />,
          h3: (p) => <h3 className="mb-1 mt-3 text-sm font-semibold" {...p} />,
          h4: (p) => <h4 className="mb-1 mt-3 text-sm font-semibold" {...p} />,
          ul: (p) => <ul className="my-1.5 list-disc space-y-1 pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 list-decimal space-y-1 pl-5" {...p} />,
          li: (p) => <li className="break-words" {...p} />,
          // The pre override owns the block-code box; the code override styles
          // inline code only, recognizable by having no language- class and no
          // newlines (react-markdown always nests block code inside a pre).
          pre: (p) => (
            <pre
              className="my-1.5 overflow-x-auto rounded-md bg-foreground/10 p-2 font-mono text-xs leading-5"
              {...p}
            />
          ),
          code: ({ className, children, ...rest }) => {
            const block =
              (className ?? '').includes('language-') || String(children).includes('\n')
            return block ? (
              <code className={className} {...rest}>{children}</code>
            ) : (
              <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
                {children}
              </code>
            )
          },
          a: (p) => (
            <a
              className="break-all underline decoration-muted-foreground underline-offset-2"
              target="_blank"
              rel="noreferrer"
              {...p}
            />
          ),
          blockquote: (p) => (
            <blockquote className="my-1 border-l-2 border-border pl-2 text-muted-foreground" {...p} />
          ),
          // Tables must scroll inside their own box — the chat column can never
          // scroll horizontally on a phone.
          table: (p) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="border-collapse text-xs" {...p} />
            </div>
          ),
          th: (p) => <th className="border border-border px-1.5 py-0.5 text-left font-semibold" {...p} />,
          td: (p) => <td className="border border-border px-1.5 py-0.5 align-top" {...p} />,
          hr: () => <hr className="my-2 border-border" />,
          strong: (p) => <strong className="font-semibold" {...p} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Thinking as a work-log row (t3-style): brain icon + first-line summary,
 * expandable to the full thought — same anatomy as ToolRow so a turn's
 * reasoning and tool calls read as one list.
 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const summary = text.split('\n', 1)[0]
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Thinking</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted-foreground">
            {summary}
          </span>
        )}
        {open ? (
          <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
}

// Per-tool icons (claude tool names + codex's shell/web_search). Anything
// unrecognized — MCP tools mostly — gets the wrench.
const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: SquareTerminal,
  shell: SquareTerminal,
  read: Eye,
  write: SquarePen,
  edit: SquarePen,
  notebookedit: SquarePen,
  grep: Search,
  glob: Search,
  webfetch: Globe,
  websearch: Globe,
  web_search: Globe,
  task: Bot,
  agent: Bot,
  todowrite: ListChecks,
}

function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name.toLowerCase()] ?? Wrench
}

/** One compact tool-call row; tap toggles the paired result output. */
function ToolRow({
  name,
  input,
  result,
  working = false,
}: {
  name: string
  input: string
  result?: ToolResultDisplay
  /** No result yet AND the turn is running near this row — show a spinner. */
  working?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => result && setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        {/* createElement instead of <Icon/>: the icon is a stateless module
            constant picked by name, not a component born in render — this
            keeps the react-compiler lint happy without a disable. */}
        {createElement(toolIcon(name), { className: 'size-3.5 shrink-0 text-muted-foreground' })}
        <span className="shrink-0 text-xs font-medium text-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {input}
        </span>
        {result?.isError ? (
          <X className="size-3 shrink-0 text-red-400" />
        ) : result ? (
          <Check className="size-3 shrink-0 text-muted-foreground/70" />
        ) : working ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </button>
      {open && result && (
        <pre
          className={cn(
            'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-foreground/5 p-2 font-mono text-[11px] leading-4 text-muted-foreground',
            result.isError && 'border-red-500/50',
          )}
        >
          {result.output}
        </pre>
      )}
    </div>
  )
}

/** The agent is mid-turn: a 3-dot pulse bubble pinned after the last message. */
function WorkingDots() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1 rounded-2xl bg-foreground/10 px-3 py-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
            style={{ animationDelay: `${i * 200}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
