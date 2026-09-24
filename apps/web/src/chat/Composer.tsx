'use client'
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { cn } from './cn'
import { VoiceMeter } from './VoiceMeter'

export type ComposerAttachment = { id: string; previewUrl: string }

/**
 * Hold-to-talk, injected because the mic pipeline is web-only (the desktop
 * consumes this same module and has no dictation transport).
 */
export type ComposerDictation = {
  /** Mic is open (or opening) — the card is a meter. */
  recording: boolean
  /** Released; the desktop is transcribing. */
  processing: boolean
  /** 0..1 live level, polled per animation frame by the meter. */
  getLevel: () => number
  start: () => void
  stop: () => void
}

/** Textarea grows with the draft up to this, then scrolls internally. */
const MAX_TEXTAREA_PX = 200

/** Keep the soft keyboard up when tapping composer buttons. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault()

/** How long the card must be held before the mic opens. */
const HOLD_MS = 350
/** Past this much travel before the mic opens, the press was a scroll. */
// Generous: a finger resting on glass drifts, and only the pre-arm window
// (HOLD_MS) is guarded at all. Real scrolls clear this well inside 350ms.
const MOVE_CANCEL_PX = 40
/** Buzz on arm, so the user knows recording started without looking. */
const HAPTIC_MS = 18

/**
 * t3code's glass composer shell, presentational: the card, an optional pinned
 * panel (pending approval / question), attachment thumbnails, the bare
 * textarea, and the footer (controls left, context meter + primary actions
 * right). All behaviour lives in ChatPane. The 16px textarea font is a hard
 * iOS constraint (smaller auto-zooms the page on focus) — never shrink it.
 */
export function Composer({
  textareaRef,
  draft,
  onDraftChange,
  onKeyDown,
  placeholder,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  attachEnabled,
  panel,
  controls,
  meter,
  actions,
  working,
  canSend,
  onSend,
  onStop,
  dictation,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>
  draft: string
  onDraftChange: (next: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  attachments: ComposerAttachment[]
  onAddFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  attachEnabled: boolean
  panel?: ReactNode
  controls?: ReactNode
  meter?: ReactNode
  /** Replaces Stop/Send while a request owns the composer (Approve/Decline, Next/Submit). */
  actions?: ReactNode
  working: boolean
  canSend: boolean
  onSend: () => void
  onStop: () => void
  /** Omitted (desktop) = no hold-to-talk, card behaves exactly as before. */
  dictation?: ComposerDictation
}) {
  // Auto-grow: measure on every draft change (covers restored drafts on mount).
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [draft, textareaRef])

  const pickFiles = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = () => onAddFiles(Array.from(input.files ?? []))
    input.click()
  }

  const imagesOf = (list: FileList | null | undefined) =>
    Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))

  // ── Hold-to-talk on the whole card ────────────────────────────────────────
  // The old dedicated mic button died with the terminal key bar, so the card
  // itself is the button now: press and hold anywhere that isn't a control, get
  // a buzz, and the box turns into a VU meter until you let go.
  const cardRef = useRef<HTMLDivElement | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  // True once THIS press actually opened the mic. `dictation.recording` can't
  // stand in: it is state, a render behind a fast tap-and-release.
  const armedRef = useRef(false)

  const clearHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = null
    originRef.current = null
  }, [])

  const endHold = useCallback(() => {
    clearHold()
    const id = pointerIdRef.current
    pointerIdRef.current = null
    if (id != null && cardRef.current?.hasPointerCapture(id)) cardRef.current.releasePointerCapture(id)
    if (!armedRef.current) return
    armedRef.current = false
    // Unconditional: stop() decides internally whether there is an utterance to
    // end. Gating on `recording` here would leak the mic on a fast release.
    dictation?.stop()
  }, [clearHold, dictation])

  useLayoutEffect(() => () => clearHold(), [clearHold])

  const onCardPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dictation || dictation.recording || dictation.processing) return
    // Touch/pen only. On a mouse, holding is how you select text.
    if (e.pointerType === 'mouse') return
    // Controls keep their own behaviour: attach, send, stop, model picker,
    // an approval button in the pinned panel.
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"], [role="menu"]')) return

    const { clientX: x, clientY: y, pointerId } = e
    originRef.current = { x, y }
    pointerIdRef.current = pointerId
    clearHold()
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null
      armedRef.current = true
      navigator.vibrate?.(HAPTIC_MS)
      // Take the pointer so a finger that drifts off the card (or a keyboard
      // collapse that moves the card) still delivers the release to us.
      try {
        cardRef.current?.setPointerCapture(pointerId)
      } catch {
        // Capture is best-effort; the up/cancel handlers still fire without it.
      }
      // Drop the caret: it collapses the soft keyboard onto the meter and takes
      // Android's long-press selection handles with it.
      textareaRef.current?.blur()
      dictation.start()
    }, HOLD_MS)
  }

  const onCardPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = originRef.current
    if (!origin || armedRef.current) return
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_CANCEL_PX) clearHold()
  }

  const dictating = !!dictation && (dictation.recording || dictation.processing)

  return (
    <div
      ref={cardRef}
      onPointerDown={onCardPointerDown}
      onPointerMove={onCardPointerMove}
      onPointerUp={endHold}
      onPointerCancel={endHold}
      onContextMenu={(e) => {
        if (armedRef.current) e.preventDefault()
      }}
      className={cn(
        'chat-composer-glass surface-grain relative flex flex-col gap-2 rounded-[22px] border border-foreground/10 p-2 shadow-[inset_0_1px_rgb(255_255_255/0.03)]',
        // Only while the mic is live, so normal copy/paste in the draft is untouched.
        dictating && 'select-none [-webkit-touch-callout:none]',
        dictation?.recording && 'border-destructive/40',
      )}
      onDragOver={(e) => {
        if (attachEnabled && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const files = imagesOf(e.dataTransfer.files)
        if (!files.length || !attachEnabled) return
        e.preventDefault()
        onAddFiles(files)
      }}
    >
      {dictating && dictation && (
        <VoiceMeter processing={!dictation.recording && dictation.processing} getLevel={dictation.getLevel} />
      )}
      {panel}

      {attachments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-1 pt-1">
          {attachments.map((a) => (
            <div key={a.id} className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/70">
              {/* eslint-disable-next-line @next/next/no-img-element -- object-URL preview */}
              <img src={a.previewUrl} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={() => onRemoveAttachment(a.id)}
                aria-label="Remove attachment"
                className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = imagesOf(e.clipboardData?.files)
          if (!files.length || !attachEnabled) return
          e.preventDefault()
          onAddFiles(files)
        }}
        placeholder={placeholder}
        aria-label="Message"
        style={{ maxHeight: MAX_TEXTAREA_PX }}
        className="w-full resize-none overflow-y-auto border-none bg-transparent px-2 pt-1 text-[16px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 sm:text-sm"
      />

      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={pickFiles}
          disabled={!attachEnabled}
          aria-label="Attach images"
          title="Attach images"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">{controls}</div>
        {meter}
        {actions ?? (
          <>
            {working && (
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={onStop}
                title="Stop (Esc)"
                aria-label="Stop the agent"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/90 text-background transition-opacity hover:opacity-90"
              >
                <Square className="size-3 fill-current" />
              </button>
            )}
            {(!working || canSend) && (
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={onSend}
                disabled={!canSend}
                aria-label={working ? 'Steer: send now' : 'Send message'}
                title={working ? 'Send now — the agent reads it mid-turn' : 'Send (Enter)'}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.16)] transition-opacity disabled:opacity-35',
                )}
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
