'use client'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { DynamicIcon } from './DynamicIcon'
import { cn } from '@/lib/utils'
import {
  ALL_SCOPE,
  buildScopeGroups,
  filterSessions,
  flattenScopeGroups,
  locateSessions,
  resumeWorkspaceId,
  type LocatedSession,
  type RemoteAgentSession,
  type ResumeWorkspaceLike,
} from '@/lib/resume-sessions'

/** Rows rendered before "show more" — the desktop sends hundreds. */
const PAGE_SIZE = 30
/** How long to wait for the desktop to answer before saying it didn't. */
const ANSWER_TIMEOUT_MS = 25_000

const AGENT_COLORS: Record<RemoteAgentSession['agent'], string> = {
  claude: '#d4a574',
  codex: '#10a37f',
}

function relativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function AgentBadge({ agent }: { agent: RemoteAgentSession['agent'] }) {
  const color = AGENT_COLORS[agent]
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded p-0.5"
      style={{ backgroundColor: `${color}18`, border: `1px solid ${color}30` }}
    >
      <DynamicIcon name={agent === 'codex' ? '__openai__' : '__claude__'} size={13} color={color} />
    </span>
  )
}

/**
 * The phone's half of "resume that session I closed": every recent Claude/Codex
 * conversation on the desktop, searchable and narrowable to one worktree, in a
 * bottom sheet sized for a thumb.
 *
 * The listing isn't part of the always-on state mirror (it's hundreds of entries
 * read off the desktop's disk), so opening the sheet inserts a request row and
 * sends a `listAgentSessions` command; the desktop fills the row in and this
 * subscribes to it. Picking one sends `resumeAgentSession` — the desktop spawns
 * it in the tree that owns its directory, exactly as its own resume drawer
 * would, and `onResumed` arms the auto-attach so the phone lands in it.
 *
 * A plain overlay rather than the shared Sheet component: this is the same
 * pattern WorktreeActionSheet uses, and it keeps the sheet clear of the base-ui
 * Dialog transition state that a backgrounded PWA can strand (see the drawer
 * remount in page.tsx).
 */
export function ResumeSheet({
  token,
  onResumed,
  onClose,
}: {
  token: string
  /** Fires with the workspace the resumed session will land in, for auto-attach. */
  onResumed: (workspaceId: string | null) => void
  onClose: () => void
}) {
  const convex = useConvex()
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [agent, setAgent] = useState<'all' | 'claude' | 'codex'>('all')
  const [scope, setScope] = useState<string>(ALL_SCOPE)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [timedOut, setTimedOut] = useState(false)
  // Frozen at open: relative timestamps that re-render every second would fight
  // the list, and a resume sheet is not open for long.
  const [now] = useState(() => Date.now())

  const state = useQuery(anyApi.remote.getRemoteState, { token }) as
    | { workspaces?: ResumeWorkspaceLike[]; activeWorkspaceId?: string | null }
    | null
    | undefined

  const listing = useQuery(anyApi.agentSessions.getAgentSessions, { token, requestId }) as
    | { status: 'loading' | 'ready' | 'error'; sessions?: RemoteAgentSession[]; error?: string }
    | null
    | undefined

  // Ask the desktop for the list (again on every refresh: a new requestId).
  useEffect(() => {
    setTimedOut(false)
    void (async () => {
      try {
        await convex.mutation(anyApi.agentSessions.requestAgentSessions, { token, requestId })
        await convex.mutation(anyApi.remote.sendCommand, {
          token,
          sessionId: '', // unused: the payload carries the request
          kind: 'listAgentSessions',
          payload: { requestId },
        })
      } catch {
        // The row simply never turns 'ready'; the timeout below explains it.
      }
    })()
  }, [convex, token, requestId])

  // A desktop that's asleep or offline never answers — say so rather than
  // spinning forever.
  useEffect(() => {
    if (listing?.status === 'ready' || listing?.status === 'error') return
    const timer = setTimeout(() => setTimedOut(true), ANSWER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [listing?.status, requestId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const located = useMemo(
    () => locateSessions(listing?.sessions, state?.workspaces, state?.activeWorkspaceId),
    [listing?.sessions, state?.workspaces, state?.activeWorkspaceId],
  )
  const byAgent = useMemo(
    () => (agent === 'all' ? located : located.filter((l) => l.session.agent === agent)),
    [located, agent],
  )
  const groups = useMemo(
    () => buildScopeGroups(byAgent.map((l) => l.scope), state?.activeWorkspaceId),
    [byAgent, state?.activeWorkspaceId],
  )
  const filtered = useMemo(
    () => filterSessions(located, { agent, scope, query }),
    [located, agent, scope, query],
  )

  // Narrowing by agent can drop the picked scope out of the picker; fall back to
  // everything rather than showing an empty list under a stale label.
  useEffect(() => {
    if (scope !== ALL_SCOPE && !flattenScopeGroups(groups).some((o) => o.value === scope)) {
      setScope(ALL_SCOPE)
    }
  }, [groups, scope])

  useEffect(() => {
    setVisible(PAGE_SIZE)
  }, [agent, scope, query])

  const loading = !listing || listing.status === 'loading'

  const resume = (picked: LocatedSession) => {
    if (!picked.session.cwdExists) return
    void convex.mutation(anyApi.remote.sendCommand, {
      token,
      sessionId: '', // unused: the payload carries the session to resume
      kind: 'resumeAgentSession',
      payload: {
        agent: picked.session.agent,
        sessionId: picked.session.sessionId,
        cwd: picked.session.cwd,
      },
    })
    onResumed(resumeWorkspaceId(picked.scope, state?.activeWorkspaceId))
    onClose()
  }

  // Portalled to <body>: the strip that opens this sheet lives inside the
  // session roll, whose translate3d container is a containing block for fixed
  // positioning — left in place, the "full-screen" overlay would only cover the
  // terminal pane and bottom out above the key bars.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // Capped to the visual viewport (--app-h, published by useAppViewport) so
        // the sheet never runs under the iOS home indicator or a soft keyboard.
        className="flex w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-sidebar shadow-2xl sm:max-w-lg sm:rounded-2xl"
        style={{ maxHeight: 'calc(var(--app-h, 100svh) * 0.85)' }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <ResumeGlyph size={14} />
          <span className="text-sm font-medium text-foreground">Resume a session</span>
          <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {loading ? '…' : filtered.length}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label="Refresh"
              onClick={() => setRequestId(crypto.randomUUID())}
              className="rounded-md p-1.5 text-muted-foreground transition-colors active:bg-accent"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8a6 6 0 0 1 10.3-4.1L14 2v4h-4l1.7-1.7A4 4 0 0 0 4 8" />
                <path d="M14 8a6 6 0 0 1-10.3 4.1L2 14v-4h4l-1.7 1.7A4 4 0 0 0 12 8" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground transition-colors active:bg-accent"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            type="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-label="Filter by workspace"
              className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            >
              <option value={ALL_SCOPE}>All workspaces</option>
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="flex shrink-0 gap-1">
              {(['all', 'claude', 'codex'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAgent(option)}
                  className={cn(
                    'rounded-md px-2 py-1.5 text-xs capitalize transition-colors',
                    agent === option
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground active:bg-accent',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-home-indicator">
          {loading && !timedOut && (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              Reading recent sessions on your desktop…
            </p>
          )}
          {loading && timedOut && (
            <p className="px-6 py-10 text-center text-xs text-muted-foreground">
              Your desktop hasn&apos;t answered. Make sure Orchestra is open on your computer, then
              refresh.
            </p>
          )}
          {listing?.status === 'error' && (
            <p className="px-6 py-10 text-center text-xs text-muted-foreground">
              Couldn&apos;t read the session history: {listing.error ?? 'unknown error'}
            </p>
          )}
          {!loading && listing?.status === 'ready' && filtered.length === 0 && (
            <p className="px-6 py-10 text-center text-xs text-muted-foreground">
              No {agent === 'all' ? 'Claude or Codex' : agent} sessions
              {query.trim() || scope !== ALL_SCOPE ? ' match these filters.' : ' found.'}
            </p>
          )}

          {filtered.slice(0, visible).map((item) => {
            const { session, scope: where } = item
            const headline = session.title ?? session.summary ?? 'Untitled session'
            const missing = !session.cwdExists
            return (
              <button
                key={`${session.agent}:${session.sessionId}`}
                type="button"
                disabled={missing}
                onClick={() => resume(item)}
                className="w-full border-b border-border/60 px-3 py-3 text-left transition-colors active:bg-accent disabled:opacity-40"
              >
                <div className="mb-1 flex items-center gap-2">
                  <AgentBadge agent={session.agent} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                    {headline}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {relativeTime(session.updatedAt, now)}
                  </span>
                </div>
                {session.title && session.summary && (
                  <p className="mb-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {session.summaryIsUser ? 'You: ' : ''}
                    {session.summary}
                  </p>
                )}
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
                  <span className="truncate">{where.text}</span>
                  {missing && <span className="shrink-0">· folder missing</span>}
                </div>
              </button>
            )
          })}

          {filtered.length > visible && (
            <button
              type="button"
              onClick={() => setVisible((n) => n + PAGE_SIZE)}
              className="w-full px-3 py-3 text-center text-xs text-muted-foreground transition-colors active:bg-accent"
            >
              Show {Math.min(PAGE_SIZE, filtered.length - visible)} more ({filtered.length - visible} older)
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The desktop's resume mark: a counter-clockwise arrow. */
export function ResumeGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
      <polyline points="2 2 2 5 5 5" />
    </svg>
  )
}
