'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, MessageSquare, SquareTerminal } from 'lucide-react'
import type { NativeChatView } from '../../../desktop/src/shared/native-chat'
import { cn } from './cn'
import type { ChatTransport } from './transport'

const AGENTS = new Set(['claude', 'codex', 'cursor'])
const ERROR_MS = 6000

/** What a session is showing: chat only while a native record owns it in chat. */
export function useChatView(transport: ChatTransport, sessionId: string): NativeChatView {
  return transport.useSnapshot(sessionId)?.view === 'chat' ? 'chat' : 'terminal'
}

/**
 * The header's Chat ⇄ Terminal segmented control. Sits in each app's own
 * header (outside `.chat-scope`), so it styles itself off currentColor and
 * inherits whatever ink that header uses. The switch is the owner handoff
 * (TUI ⇄ SDK) and can take seconds: spinner + disabled while in flight, and a
 * refusal ("The agent is mid-turn…") pops up under the control.
 */
export function ViewToggle({
  sessionId,
  transport,
  agent,
  className,
}: {
  sessionId: string
  transport: ChatTransport
  /** The session's processStatus — the toggle shows for agent sessions. */
  agent?: string
  className?: string
}) {
  const snapshot = transport.useSnapshot(sessionId)
  const view: NativeChatView = snapshot?.view === 'chat' ? 'chat' : 'terminal'
  const [pending, setPending] = useState<NativeChatView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  // A different session's error must not follow the header to this one.
  useEffect(() => {
    setError(null)
    setPending(null)
  }, [sessionId])

  if (!(agent && AGENTS.has(agent)) && !snapshot) return null

  const choose = (next: NativeChatView) => {
    if (pending || next === view) return
    setPending(next)
    setError(null)
    transport
      .setView(sessionId, next)
      .catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message ? cause.message : `Could not switch to ${next}`)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setError(null), ERROR_MS)
      })
      .finally(() => setPending(null))
  }

  const shown = pending ?? view
  const segment = (value: NativeChatView, label: string, Icon: typeof MessageSquare) => (
    <button
      type="button"
      role="radio"
      aria-checked={shown === value}
      aria-label={label}
      title={label}
      disabled={pending !== null}
      onClick={() => choose(value)}
      className={cn(
        'flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium transition-colors disabled:cursor-default',
        shown === value ? 'bg-current/15 opacity-100' : 'opacity-55 hover:opacity-90',
      )}
    >
      {pending === value ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )

  // The error pops out under the control. Portalled + fixed: both headers
  // clip their overflow (the desktop's is a drag region too).
  const rect = error ? rootRef.current?.getBoundingClientRect() : undefined
  return (
    <div ref={rootRef} className={cn('relative shrink-0', className)}>
      <div
        role="radiogroup"
        aria-label="Session view"
        aria-busy={pending !== null}
        className="flex items-center gap-0.5 rounded-md border border-current/15 p-0.5"
      >
        {segment('chat', 'Chat', MessageSquare)}
        {segment('terminal', 'Terminal', SquareTerminal)}
      </div>
      {error &&
        rect &&
        createPortal(
          <div
            role="alert"
            onClick={() => setError(null)}
            style={{ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }}
            className="fixed z-[200] w-64 max-w-[80vw] cursor-pointer rounded-md bg-neutral-900/95 px-3 py-2 text-xs leading-snug text-white shadow-lg ring-1 ring-white/10"
          >
            {error}
          </div>,
          document.body,
        )}
    </div>
  )
}
