import { memo, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Clock, Copy, Image as ImageIcon } from 'lucide-react'
import { cn } from '../lib/utils'
import { splitUserImageTokens, type DisplayBlock } from '../lib/chat-messages'
import { formatElapsed, type TimelineRow } from '../lib/chat-timeline'
import { ChatMarkdown } from './ChatMarkdown'

// Presentational timeline rows (everything except WorkRow and the question
// card). All state here is cosmetic — copy feedback, long-message collapse —
// and is lost on the pane's foreground remount by design.

type UserRow = Extract<TimelineRow, { kind: 'user' }>
type AssistantRow = Extract<TimelineRow, { kind: 'assistant' }>
type TurnFoldRow = Extract<TimelineRow, { kind: 'turn-fold' }>
type WorkToggleRow = Extract<TimelineRow, { kind: 'work-toggle' }>

// Hover-reveal on fine pointers only; phones (coarse pointers) always show the
// meta row dimmed — `sm:` would key on width, which is the wrong axis.
const HOVER_META =
  'opacity-60 transition-opacity duration-200 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:focus-within:opacity-100'

// ── Timestamps ───────────────────────────────────────────────────────────────

let shortTimeFmt: Intl.DateTimeFormat | null = null
function shortTime(ts: number): string {
  if (!shortTimeFmt) {
    shortTimeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  return shortTimeFmt.format(ts)
}

function fullTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

// ── Copy button ──────────────────────────────────────────────────────────────

const COPIED_MS = 1200

export function CopyButton({ text, label = 'Copy message' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={copy}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
    </button>
  )
}

// ── Simple rows ──────────────────────────────────────────────────────────────

export function DayDividerRow({ label }: { label: string }) {
  return (
    <div className="py-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </div>
  )
}

export function SystemRow({ text }: { text: string }) {
  return <div className="py-0.5 text-center text-[11px] text-muted-foreground">{text}</div>
}

// ── User row ─────────────────────────────────────────────────────────────────

const MAX_COLLAPSED_CHARS = 600
const MAX_COLLAPSED_LINES = 8
const COLLAPSED_FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)'
const MAX_ECHO_THUMBS = 4

function userText(blocks: DisplayBlock[]): string {
  return blocks
    .filter((b): b is Extract<DisplayBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

export const UserRow = memo(function UserRow({
  row,
  previewUrls,
}: {
  row: UserRow
  previewUrls?: string[]
}) {
  const [showFull, setShowFull] = useState(false)

  const raw = userText(row.item.blocks)
  const { text, imageCount: tokenCount } = splitUserImageTokens(raw)
  const imageBlockCount = row.item.blocks.filter((b) => b.kind === 'image').length
  const thumbs = previewUrls && previewUrls.length > 0 ? previewUrls.slice(0, MAX_ECHO_THUMBS) : null
  // Thumbnails stand in for ALL of the message's images — after echo adoption
  // the mirrored copy still carries its typed path tokens, and rendering both
  // the grid and a chip would double-report every phone-sent photo. Chips are
  // the fallback for messages with no previews at all.
  // …and the two counts are two VIEWS of the same attachments, not two sets:
  // claude's record carries one `[Image #N]` token *and* one image block per
  // photo, so adding them reported every single image as "2 images". A queued
  // row has only the token (nothing ingested yet), a pasted image only the
  // block — hence max, not either one alone.
  const chipCount = thumbs ? 0 : Math.max(tokenCount, imageBlockCount)

  const collapsible =
    text.length > MAX_COLLAPSED_CHARS || text.split('\n').length > MAX_COLLAPSED_LINES
  const collapsed = collapsible && !showFull

  return (
    <div className={cn('group flex flex-col items-end gap-1', row.pending && 'opacity-70')}>
      <div className="relative max-w-[80%] rounded-2xl bg-accent p-3">
        {thumbs && (
          <div className={cn('mb-2 grid gap-1.5', thumbs.length > 1 && 'grid-cols-2')}>
            {thumbs.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={url} alt="" className="size-20 rounded-lg object-cover" />
            ))}
          </div>
        )}
        {chipCount > 0 && (
          <div className="mb-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" />
            {chipCount === 1 ? 'image' : `${chipCount} images`}
          </div>
        )}
        {text && (
          <>
            <div
              className={cn(
                'whitespace-pre-wrap break-words text-sm text-foreground',
                collapsed && 'max-h-44 overflow-hidden',
              )}
              style={
                collapsed
                  ? { maskImage: COLLAPSED_FADE_MASK, WebkitMaskImage: COLLAPSED_FADE_MASK }
                  : undefined
              }
            >
              {text}
            </div>
            {collapsible && (
              <button
                type="button"
                data-scroll-anchor-ignore
                onClick={() => setShowFull((v) => !v)}
                className="-ml-1 mt-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                {showFull ? 'Show less' : 'Show full message'}
              </button>
            )}
          </>
        )}
      </div>
      {/* Deliberately NOT in the hover-reveal meta row below: "queued" answers
          "did my message go through?", which is the one thing a reader wants to
          know the moment they can't see their message in the conversation. */}
      {row.queued && (
        <div className="flex items-center gap-1 pe-1 text-[11px] font-medium text-muted-foreground">
          <Clock className="size-3" />
          Queued — the agent picks it up when it finishes this step
        </div>
      )}
      <div
        className={cn(
          'flex w-full max-w-[80%] items-center justify-end gap-1.5 pe-1 text-xs tabular-nums',
          HOVER_META,
          '[@media(pointer:fine)]:group-hover:opacity-100',
        )}
      >
        {row.ts != null && (
          <span className="text-xs tabular-nums text-muted-foreground" title={fullTime(row.ts)}>
            {shortTime(row.ts)}
          </span>
        )}
        {text && <CopyButton text={text} />}
      </div>
    </div>
  )
})

// ── Assistant row ────────────────────────────────────────────────────────────

function assistantText(blocks: DisplayBlock[]): string {
  return blocks
    .filter((b): b is Extract<DisplayBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

export const AssistantRow = memo(function AssistantRow({ row }: { row: AssistantRow }) {
  const copyText = assistantText(row.blocks)
  return (
    <div className="group/assistant relative min-w-0 px-1 py-0.5">
      {row.blocks.map((b, i) => {
        if (b.kind === 'text') return <ChatMarkdown key={i} text={b.text} />
        if (b.kind === 'image') {
          return (
            <div key={i} className="flex items-center gap-1 text-xs italic text-muted-foreground">
              <ImageIcon className="size-3.5" />
              {b.alt ?? 'image'}
            </div>
          )
        }
        return null
      })}
      {row.terminal && (
        <div
          className={cn(
            'mt-1.5 flex items-center gap-1.5 text-xs tabular-nums',
            HOVER_META,
            '[@media(pointer:fine)]:group-hover/assistant:opacity-100',
          )}
        >
          {copyText.trim().length > 0 && <CopyButton text={copyText} />}
          {row.ts != null && (
            <span className="text-xs tabular-nums text-muted-foreground" title={fullTime(row.ts)}>
              {shortTime(row.ts)}
            </span>
          )}
        </div>
      )}
    </div>
  )
})

// ── Turn fold ────────────────────────────────────────────────────────────────

export function TurnFoldRow({
  row,
  onToggle,
}: {
  row: TurnFoldRow
  onToggle: (turnId: string) => void
}) {
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => onToggle(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        {row.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
    </div>
  )
}

// ── Work-group overflow toggle ───────────────────────────────────────────────

export function WorkToggleRow({
  row,
  onToggle,
}: {
  row: WorkToggleRow
  onToggle: (groupId: string, anchor: HTMLElement) => void
}) {
  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      onClick={(e) => onToggle(row.groupId, e.currentTarget)}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 opacity-70 transition-transform duration-200',
            row.expanded && 'rotate-180',
          )}
        />
      </span>
      <span className="font-medium text-foreground/82">
        {row.expanded ? 'Show fewer tool calls' : `+${row.hiddenCount} previous tool calls`}
      </span>
    </button>
  )
}

// ── Working row ──────────────────────────────────────────────────────────────

/**
 * Self-ticking elapsed label: mutates textContent on a 1s interval instead of
 * re-rendering — the timeline must not pay a React commit per second while the
 * agent streams.
 */
function ElapsedTimer({ sinceTs }: { sinceTs: number }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = formatElapsed(Date.now() - sinceTs)
    }
    // First fill happens here, not in render — Date.now() in render trips the
    // react-compiler purity rule, and the one-frame-late label is invisible.
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [sinceTs])
  return <span ref={ref} />
}

export function WorkingRow({ sinceTs }: { sinceTs: number | null }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {sinceTs != null ? (
            <>
              Working for <ElapsedTimer sinceTs={sinceTs} />
            </>
          ) : (
            'Working...'
          )}
        </span>
      </div>
    </div>
  )
}
