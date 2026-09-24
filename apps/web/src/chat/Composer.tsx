'use client'
import { useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { cn } from './cn'

export type ComposerAttachment = { id: string; previewUrl: string }

/** Textarea grows with the draft up to this, then scrolls internally. */
const MAX_TEXTAREA_PX = 200

/** Keep the soft keyboard up when tapping composer buttons. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault()

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

  return (
    <div
      className="chat-composer-glass surface-grain flex flex-col gap-2 rounded-[22px] border border-foreground/10 p-2 shadow-[inset_0_1px_rgb(255_255_255/0.03)]"
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
