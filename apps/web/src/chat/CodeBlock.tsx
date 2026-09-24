'use client'
// t3-style code card: header (language · wrap toggle · copy) over a
// Shiki-highlighted body. Highlighting is async and best-effort — the block
// renders instantly as a plain <pre> and upgrades in place when the
// highlighter resolves (null = unknown language/failure → the plain pre just
// stays). Card surface/typography live in globals.css under
// `.chat-markdown .chat-markdown-codeblock`.

import { memo, useEffect, useRef, useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'
import { cn } from './cn'
import { highlight } from './shiki'

const COPY_FLASH_MS = 1200

type Highlighted = { code: string; lang: string; html: string }

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null)
  const [wrapped, setWrapped] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!lang) return
    let cancelled = false
    void highlight(code, lang).then((result) => {
      if (!cancelled && result) setHighlighted({ code, lang, html: result })
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  // The stored HTML is keyed by its inputs, so a row whose code changed under
  // us falls back to the plain pre until the fresh highlight lands (no
  // clear-state-in-effect needed).
  const html =
    highlighted && highlighted.code === code && highlighted.lang === lang
      ? highlighted.html
      : null

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    [],
  )

  const onCopy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => setCopied(false), COPY_FLASH_MS)
      })
      .catch(() => {
        // Clipboard denied (non-secure context) — nothing useful to show.
      })
  }

  return (
    <div
      className="chat-markdown-codeblock overflow-hidden rounded-[var(--radius)] border border-border bg-surface-raised"
      data-language={lang}
      data-wrap={wrapped ? 'true' : 'false'}
    >
      <div className="flex select-none items-center gap-1 py-1 pl-3 pr-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {lang ?? 'text'}
        </span>
        <span className="min-w-2 flex-1" />
        <button
          type="button"
          aria-pressed={wrapped}
          aria-label={wrapped ? 'Disable line wrap' : 'Wrap lines'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setWrapped((w) => !w)}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            wrapped && 'bg-foreground/10 text-foreground',
          )}
        >
          <WrapText className="size-3" />
        </button>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCopy}
          className="flex size-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
        </button>
      </div>
      {html ? (
        // Shiki emits its own <pre class="shiki"> — globals force its
        // background transparent so the card surface shows through.
        <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})
