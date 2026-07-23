'use client'
import { useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Web-side shape of the linked ticket the desktop mirrors into remoteState.
export interface LinearIssueDetail {
  identifier: string
  title: string
  url: string
  description: string | null
  priority: number
  state: { name: string; color: string; type: string }
  labels: { id: string; name: string; color: string }[]
  assignee: { displayName: string; avatarUrl: string | null } | null
}

interface TicketDraft {
  status: 'generating' | 'ready' | 'creating' | 'created' | 'error' | 'cancelled'
  draft?: { title: string; description: string; labelNames: string[]; projectName: string | null; priority: number }
  viewer?: { id: string; displayName: string } | null
  projects?: { id: string; name: string }[]
  labels?: { id: string; name: string; color: string }[]
  result?: { identifier: string; url: string }
  error?: string
}

const LINEAR_BRAND = '#5E6AD2'
const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

/** The Linear logo mark (simple three-bar glyph), tinted by `color`. */
function LinearGlyph({ color, className }: { color: string; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill={color} aria-hidden>
      <path d="M1.2 61.5a2 2 0 0 1 3.4-1L40 96a2 2 0 0 1-1 3.4C21 95.3 6.3 80.6 1.2 61.5Z" />
      <path d="M.2 46.9a2 2 0 0 0 .6 1.6l51.4 51.4a2 2 0 0 0 1.6.6 51 51 0 0 0 8.6-1.5 2 2 0 0 0 .9-3.4L4.3 37.4a2 2 0 0 0-3.4 1A51 51 0 0 0 .2 47Z" />
      <path d="M6.6 26.2a2 2 0 0 0 .4 2.3l64.9 64.9a2 2 0 0 0 2.3.4c2.2-1 4.3-2.3 6.3-3.7a2 2 0 0 0 .3-3L13.3 19.6a2 2 0 0 0-3-.3c-1.4 2-2.7 4-3.7 6.3Z" />
      <path d="M22.2 10.6a2 2 0 0 0-.2 3l64.4 64.4a2 2 0 0 0 3-.2C99.3 63 100.7 43 91 26.9 84.3 15.7 73.3 4.7 62.1.9 46-8.7 26-7.3 12 3.5c-.6.5-1.2 1-1.8 1.6Z" />
    </svg>
  )
}

export function LinearTicketButton({
  token,
  sessionId,
  issue,
}: {
  token: string
  sessionId: string | null
  issue: LinearIssueDetail | null | undefined
}) {
  const convex = useConvex()
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Poll the draft row once we've kicked off generation.
  const draft = useQuery(
    anyApi.ticketDrafts.getTicketDraft,
    requestId ? { token, requestId } : 'skip',
  ) as TicketDraft | null | undefined

  // Close the floating card on an outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // When a create succeeds, drop the draft — the mirror will flip `issue` to the
  // new colored ticket shortly after the branch rename.
  useEffect(() => {
    if (draft?.status === 'created') {
      const t = setTimeout(() => {
        setRequestId(null)
        setOpen(false)
      }, 1200)
      return () => clearTimeout(t)
    }
  }, [draft?.status])

  const startGeneration = async () => {
    if (!sessionId) return
    const id = crypto.randomUUID()
    setRequestId(id)
    setOpen(true)
    try {
      await convex.mutation(anyApi.ticketDrafts.startTicketDraft, { token, requestId: id, sessionId })
      await convex.mutation(anyApi.remote.sendCommand, {
        token,
        sessionId,
        kind: 'generateTicketDraft',
        payload: { requestId: id },
      })
    } catch {
      // getTicketDraft will simply never resolve to 'ready'; the card shows retry.
    }
  }

  const cancel = async () => {
    if (requestId) {
      try {
        await convex.mutation(anyApi.ticketDrafts.cancelTicketDraft, { token, requestId })
      } catch { /* ignore */ }
    }
    setRequestId(null)
    setOpen(false)
  }

  const onIconClick = () => {
    if (!sessionId) return
    if (issue) {
      setOpen((o) => !o)
    } else if (requestId && open) {
      setOpen(false)
    } else {
      void startGeneration()
    }
  }

  const generating = !!requestId && (!draft || draft.status === 'generating')
  const showColored = !!issue

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={!sessionId}
        aria-label={issue ? `Linear ${issue.identifier}` : 'Create a Linear ticket for this worktree'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onIconClick}
        className="size-7"
      >
        {generating ? (
          <Loader2 className="size-4 animate-spin" style={{ color: LINEAR_BRAND }} />
        ) : (
          <LinearGlyph
            color={showColored ? LINEAR_BRAND : 'currentColor'}
            className={cn('size-4', !showColored && 'text-muted-foreground/50')}
          />
        )}
      </Button>

      {open && issue && (
        <TicketDetailCard issue={issue} onClose={() => setOpen(false)} />
      )}

      {open && !issue && requestId && (
        <DraftCard
          draft={draft}
          generating={generating}
          onCancel={cancel}
          onRetry={startGeneration}
          onCreate={async (fields) => {
            await convex.mutation(anyApi.remote.sendCommand, {
              token,
              sessionId: sessionId!,
              kind: 'createLinearTicket',
              payload: { requestId, fields },
            })
          }}
        />
      )}
    </div>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute right-0 top-9 z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
      {children}
    </div>
  )
}

function TicketDetailCard({ issue, onClose }: { issue: LinearIssueDetail; onClose: () => void }) {
  return (
    <CardShell>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: issue.state.color }} />
          {issue.state.name}
        </span>
      </div>
      <div className="mb-2 text-sm font-medium leading-snug">{issue.title}</div>
      {issue.description && (
        <p className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {issue.description}
        </p>
      )}
      {issue.labels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
            >
              <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          ))}
        </div>
      )}
      {issue.assignee && (
        <div className="mb-3 text-xs text-muted-foreground">Assigned to {issue.assignee.displayName}</div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" className="flex-1" onClick={() => window.open(issue.url, '_blank', 'noopener')}>
          <ExternalLink className="size-3.5" /> Open in Linear
        </Button>
      </div>
    </CardShell>
  )
}

function DraftCard({
  draft,
  generating,
  onCancel,
  onRetry,
  onCreate,
}: {
  draft: TicketDraft | null | undefined
  generating: boolean
  onCancel: () => void
  onRetry: () => void
  onCreate: (fields: {
    title: string
    description: string
    labelIds: string[]
    projectId: string | null
    priority: number
    assigneeId: string | null
  }) => Promise<void>
}) {
  if (generating) {
    return (
      <CardShell>
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" style={{ color: LINEAR_BRAND }} />
          Analyzing this worktree…
        </div>
      </CardShell>
    )
  }

  if (draft?.status === 'error' || draft?.status === 'cancelled') {
    return (
      <CardShell>
        <div className="mb-3 text-sm text-destructive">
          {draft.error || 'Ticket generation was cancelled.'}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={onCancel}>
            Close
          </Button>
          <Button size="sm" className="flex-1" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </CardShell>
    )
  }

  if (draft?.status === 'created') {
    return (
      <CardShell>
        <div className="py-4 text-center text-sm">
          Created <span className="font-mono">{draft.result?.identifier}</span> 🎉
        </div>
      </CardShell>
    )
  }

  if (draft?.status === 'ready' && draft.draft) {
    return <DraftEditor draft={draft} onCancel={onCancel} onCreate={onCreate} />
  }

  return null
}

function DraftEditor({
  draft,
  onCancel,
  onCreate,
}: {
  draft: TicketDraft
  onCancel: () => void
  onCreate: (fields: {
    title: string
    description: string
    labelIds: string[]
    projectId: string | null
    priority: number
    assigneeId: string | null
  }) => Promise<void>
}) {
  const d = draft.draft!
  const projects = draft.projects ?? []
  const labels = draft.labels ?? []
  const viewer = draft.viewer ?? null

  const [title, setTitle] = useState(d.title)
  const [description, setDescription] = useState(d.description)
  const [priority, setPriority] = useState(d.priority)
  const [projectId, setProjectId] = useState<string | null>(
    projects.find((p) => p.name === d.projectName)?.id ?? null,
  )
  const [labelIds, setLabelIds] = useState<string[]>(
    labels.filter((l) => d.labelNames.includes(l.name)).map((l) => l.id),
  )
  const [submitting, setSubmitting] = useState(false)

  const toggleLabel = (id: string) =>
    setLabelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const submit = async () => {
    if (!title.trim() || submitting) return
    setSubmitting(true)
    try {
      await onCreate({ title: title.trim(), description, labelIds, projectId, priority, assigneeId: viewer?.id ?? null })
    } finally {
      // The parent flips to 'creating'/'created' via the draft row; keep disabled.
    }
  }

  return (
    <CardShell>
      <div className="mb-2 text-xs font-medium text-muted-foreground">New Linear ticket</div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={4}
        className="mb-2 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="mb-2 flex gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
          className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs outline-none"
        >
          {PRIORITIES.map((label, i) => (
            <option key={i} value={i}>{label}</option>
          ))}
        </select>
        <select
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value || null)}
          className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs outline-none"
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {labels.length > 0 && (
        <div className="mb-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
          {labels.map((l) => {
            const on = labelIds.includes(l.id)
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => toggleLabel(l.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  on ? 'border-transparent bg-primary text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </button>
            )
          })}
        </div>
      )}
      {viewer && (
        <div className="mb-3 text-xs text-muted-foreground">Assignee: {viewer.displayName}</div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={onCancel} disabled={submitting}>
          <X className="size-3.5" /> Cancel
        </Button>
        <Button size="sm" className="flex-1" onClick={submit} disabled={!title.trim() || submitting}>
          {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null} Create
        </Button>
      </div>
    </CardShell>
  )
}
