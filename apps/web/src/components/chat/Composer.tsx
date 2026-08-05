'use client'
import { useLayoutEffect, useRef } from 'react'
import { ArrowUp, LoaderCircle, Mic, Plus, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMeter } from './ContextMeter'

export type ComposerAttachment = {
  id: string
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
}

export type ComposerProps = {
  draft: string
  onDraftChange: (next: string) => void
  onSend: () => void
  canSend: boolean
  working: boolean
  onInterrupt: () => void
  attachments: ComposerAttachment[]
  onPickFiles: () => void
  onRemoveAttachment: (id: string) => void
  attachEnabled: boolean
  dictation: { listening: boolean; processing: boolean; error: string | null }
  micProps: React.ButtonHTMLAttributes<HTMLButtonElement>
  modelPill?: React.ReactNode
  contextRatio: number | null
  onTextareaKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
}

/** Textarea grows with the draft up to this, then scrolls internally. */
const MAX_TEXTAREA_PX = 120

/**
 * Keep the iOS soft keyboard up when tapping composer buttons: preventing
 * mousedown default stops the textarea from blurring.
 */
const keepKeyboard = (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault()

/**
 * Presentational glass composer shell (t3 style). All send/upload/dictation
 * logic lives in ChatPane — this renders the card, the bare textarea, the
 * attachment strip, and the action row, and calls back out for everything.
 * The 16px textarea font is a hard iOS constraint (auto-zoom wedge) — never
 * shrink it.
 */
export function Composer(props: ComposerProps) {
  const {
    draft,
    onDraftChange,
    onSend,
    canSend,
    working,
    onInterrupt,
    attachments,
    onPickFiles,
    onRemoveAttachment,
    attachEnabled,
    dictation,
    micProps,
    modelPill,
    contextRatio,
    onTextareaKeyDown,
    placeholder,
  } = props

  const innerTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-grow: measure on every draft change (covers restored drafts on mount).
  useLayoutEffect(() => {
    const el = innerTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [draft])

  const dictationLine = dictation.error
    ? dictation.error
    : dictation.processing
      ? 'Transcribing…'
      : dictation.listening
        ? 'Listening…'
        : null

  return (
    <div className="chat-composer-glass surface-grain flex flex-col gap-2 rounded-[22px] border border-foreground/8 p-2 shadow-[inset_0_1px_rgb(255_255_255/0.03)]">
      {dictationLine != null && (
        <div
          className={cn(
            'px-2 text-xs text-muted-foreground',
            dictation.error != null && 'text-destructive',
          )}
        >
          {dictationLine}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/70"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- object-URL preview */}
              <img src={a.previewUrl} alt="" className="h-full w-full object-cover" />
              {a.status === 'uploading' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <LoaderCircle className="size-4 animate-spin text-white" />
                </div>
              )}
              {a.status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-destructive/60 text-[10px] font-medium text-white">
                  failed
                </div>
              )}
              <button
                type="button"
                onMouseDown={keepKeyboard}
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
        ref={innerTextareaRef}
        rows={1}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onTextareaKeyDown}
        placeholder={placeholder ?? 'Message the agent'}
        style={{ maxHeight: MAX_TEXTAREA_PX }}
        className="w-full resize-none overflow-y-auto border-none bg-transparent px-2 pt-1 text-[16px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
      />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onMouseDown={keepKeyboard}
          onClick={onPickFiles}
          disabled={!attachEnabled}
          aria-label="Attach images"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground active:bg-surface-hover disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>

        {modelPill}

        <ContextMeter ratio={contextRatio} />

        <div className="min-w-0 flex-1" />

        <button
          {...micProps}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            micProps.onMouseDown?.(e)
          }}
          aria-label={micProps['aria-label'] ?? 'Hold to talk'}
          className={cn(
            'flex size-8 shrink-0 touch-none select-none items-center justify-center rounded-full',
            dictation.listening
              ? 'animate-pulse bg-destructive text-white'
              : dictation.processing
                ? 'bg-destructive/60 text-white opacity-80'
                : 'border border-border/70 text-muted-foreground',
            micProps.className,
          )}
        >
          <Mic className="size-4" />
        </button>

        {/* Always rendered, not gated on `working`: the mirrored working flag
            is throttled and can lag a phone-sent prompt (or a TUI dialog left
            open from the desk needs a bare Esc while "idle") — exactly the
            moments the interrupt is reached for. Working only changes the tint. */}
        <button
          type="button"
          onMouseDown={keepKeyboard}
          onClick={onInterrupt}
          title="Interrupt (Esc)"
          aria-label="Interrupt (Esc)"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full border',
            working
              ? 'border-destructive/50 text-destructive active:bg-destructive/10'
              : 'border-border/70 text-muted-foreground active:bg-surface-hover',
          )}
        >
          <Square className="size-3.5 fill-current" />
        </button>

        <button
          type="button"
          onMouseDown={keepKeyboard}
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.16)] disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}
