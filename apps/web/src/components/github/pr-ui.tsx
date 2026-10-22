'use client'
// The pull-request page's small shared pieces: state, checks and review marks
// in t3code's colours, avatars, label chips, the +/- stat, toasts, and the
// click-twice confirm every consequential button uses.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  TriangleAlert,
  UserCheck,
  UserRound,
  UserRoundX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  checksOverall,
  labelTextColor,
  type CheckBucket,
  type CheckSummary,
  type GitHubUser,
  type PullState,
  type ReviewDecision,
} from '@/lib/github'

export const STATE_PRESENTATION: Record<PullState, { label: string; className: string; Icon: typeof GitMerge }> = {
  OPEN: { label: 'Open', className: 'text-emerald-400', Icon: GitPullRequestArrow },
  DRAFT: { label: 'Draft', className: 'text-zinc-400', Icon: GitPullRequestDraft },
  CLOSED: { label: 'Closed', className: 'text-red-400', Icon: GitPullRequestClosed },
  MERGED: { label: 'Merged', className: 'text-violet-400', Icon: GitMerge },
}

export function PullStateIcon({
  state,
  conflicting,
  baseRefName,
  className,
}: {
  state: PullState
  conflicting?: boolean
  baseRefName?: string
  className?: string
}) {
  const { Icon, className: tone, label } = STATE_PRESENTATION[state]
  return (
    <span className="relative inline-flex shrink-0" title={conflicting ? `Conflicts with ${baseRefName ?? 'base'}` : label}>
      <Icon aria-hidden className={cn('size-4', tone, className)} />
      {conflicting && state === 'OPEN' && (
        <TriangleAlert aria-hidden className="absolute -bottom-1 -right-1 size-3 fill-background text-red-400" />
      )}
    </span>
  )
}

export function ChecksIcon({ checks, className }: { checks: CheckSummary; className?: string }) {
  const overall = checksOverall(checks)
  if (overall === 'passing') return <CircleCheck aria-label="Checks passing" className={cn('size-3.5 text-emerald-400', className)} />
  if (overall === 'failing') return <CircleX aria-label="Checks failing" className={cn('size-3.5 text-red-400', className)} />
  if (overall === 'pending') return <CircleDot aria-label="Checks running" className={cn('size-3.5 text-amber-400', className)} />
  return null
}

export const CHECK_PRESENTATION: Record<CheckBucket, { label: string; className: string; Icon: typeof CircleX; spin?: boolean }> = {
  fail: { label: 'Failed', className: 'text-red-400', Icon: CircleX },
  action: { label: 'Awaiting action', className: 'text-amber-400', Icon: CircleDot },
  pending: { label: 'Running', className: 'text-amber-400', Icon: LoaderCircle, spin: true },
  pass: { label: 'Passed', className: 'text-emerald-400', Icon: CircleCheck },
  skipped: { label: 'Skipped', className: 'text-muted-foreground/70', Icon: CircleSlash },
}

export function CheckBucketIcon({ bucket }: { bucket: CheckBucket }) {
  const { Icon, className, spin } = CHECK_PRESENTATION[bucket] ?? { Icon: CircleDashed, className: '' }
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', className, spin && 'animate-spin')} />
}

export function ReviewIcon({ decision }: { decision: ReviewDecision }) {
  if (decision === 'APPROVED') return <UserCheck aria-label="Approved" className="size-3.5 text-emerald-400" />
  if (decision === 'CHANGES_REQUESTED')
    return <UserRoundX aria-label="Changes requested" className="size-3.5 text-amber-400/90" />
  if (decision === 'REVIEW_REQUIRED')
    return <UserRound aria-label="Awaiting review" className="size-3.5 text-muted-foreground/60" />
  return null
}

export function Avatar({ user, size = 14, className }: { user?: GitHubUser; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false)
  const letter = (user?.login ?? '?').slice(0, 1).toUpperCase()
  if (!user?.avatarUrl || failed) {
    return (
      <span
        style={{ width: size, height: size, fontSize: size * 0.55 }}
        className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground', className)}
      >
        {letter}
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static export, remote avatars
    <img
      src={user.avatarUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
      className={cn('shrink-0 rounded-full bg-muted', className)}
    />
  )
}

export function LabelChip({ label }: { label: { name: string; color: string } }) {
  return (
    <span
      style={{ backgroundColor: `#${label.color}`, color: labelTextColor(label.color) }}
      className="inline-flex max-w-32 shrink-0 items-center truncate rounded-full px-1.5 py-px text-[10px] font-medium leading-4"
    >
      {label.name}
    </span>
  )
}

export function DiffStat({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  if (!additions && !deletions) return null
  return (
    <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', className)}>
      <span className="text-emerald-400">+{additions}</span> <span className="text-red-400">-{deletions}</span>
    </span>
  )
}

// ── Toasts ───────────────────────────────────────────────────────────────

interface Toast {
  id: number
  tone: 'ok' | 'error'
  title: string
  body?: string
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++next.current
    setToasts((cur) => [...cur.slice(-2), { ...t, id }])
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), t.tone === 'error' ? 7000 : 3500)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto w-full max-w-sm rounded-lg border px-3 py-2 text-sm shadow-xl animate-in fade-in slide-in-from-bottom-2',
              t.tone === 'error' ? 'border-red-900/70 bg-red-950/90 text-red-100' : 'border-border bg-popover text-foreground',
            )}
          >
            <div className="font-medium">{t.title}</div>
            {t.body && <div className="mt-0.5 text-xs leading-snug opacity-80">{t.body}</div>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// ── Click twice to confirm ───────────────────────────────────────────────

/**
 * t3code's inline confirm: the first click arms the button ("Confirm merge?"),
 * the second runs it. Disarms after 3s or on Escape, so a stray tap never
 * merges anything.
 */
export function useInlineConfirm(): {
  armed: string | null
  arm: (key: string) => void
  disarm: () => void
} {
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(null), 3000)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArmed(null)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [armed])
  return { armed, arm: setArmed, disarm: useCallback(() => setArmed(null), []) }
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('Clipboard unavailable'))
}
