'use client'
// One pull request, after t3code's detail panel: a header with the one
// primary action the PR's state allows (merge, auto-merge, ready for review,
// resolve conflicts), a "⋯" menu for the rest, Summary / Timeline / Code tabs,
// and a floating composer for comments and reviews.

import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  FileDiff,
  GitBranch,
  GitMerge,
  Link as LinkIcon,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  SquareTerminal,
  Tag,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ACTION_DONE,
  MERGE_METHOD_LABEL,
  canWrite,
  checksOverall,
  checksSummaryText,
  chooseMergeMethod,
  immediatelyMergeable,
  primaryControl,
  relativeTime,
  type GitHubCheck,
  type MergeMethod,
  type PullAction,
  type PullDetail,
  type TimelineItem,
} from '@/lib/github'
import { ConfirmSheet } from '../ConfirmSheet'
import { PullRequestDiff } from './PullRequestDiff'
import {
  Avatar,
  CHECK_PRESENTATION,
  CheckBucketIcon,
  ChecksIcon,
  DiffStat,
  LabelChip,
  STATE_PRESENTATION,
  copyText,
  useInlineConfirm,
  useToast,
} from './pr-ui'

type Tab = 'summary' | 'timeline' | 'code'

const METHOD_KEY = 'orchestra.pullRequests.mergeMethod'

function readLastMethod(): MergeMethod | null {
  try {
    const v = localStorage.getItem(METHOD_KEY)
    return v === 'MERGE' || v === 'SQUASH' || v === 'REBASE' ? v : null
  } catch {
    return null
  }
}

/** Failure hints, worded like t3code's: what GitHub most likely refused and why. */
function failureHint(kind: PullAction['kind']): string | undefined {
  if (kind === 'merge')
    return 'GitHub refused the merge. Check that you have write access, that the required checks have passed, and that the branch is not conflicting.'
  if (kind === 'approve' || kind === 'requestChanges') return 'Authors can’t approve or request changes on their own pull request.'
  return undefined
}

export function PullRequestDetail({
  rootDir,
  pr,
  loading,
  error,
  onBack,
  onRefresh,
  run,
  sessionForBranch,
  onOpenSession,
  now,
}: {
  rootDir: string
  pr: PullDetail | undefined
  loading: boolean
  error: string | null
  onBack: () => void
  onRefresh: () => void
  run: (number: number, action: PullAction) => Promise<unknown>
  sessionForBranch: (branch: string) => string | null
  onOpenSession: (sessionId: string) => void
  now: number
}) {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('summary')
  const [busy, setBusy] = useState<PullAction['kind'] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [lastMethod, setLastMethod] = useState<MergeMethod | null>(() => readLastMethod())
  const [deleteBranch, setDeleteBranch] = useState<boolean | null>(null)
  const confirm = useInlineConfirm()

  const act = async (action: PullAction) => {
    if (!pr) return
    confirm.disarm()
    setMenuOpen(false)
    setBusy(action.kind)
    try {
      await run(pr.number, action)
      toast({
        tone: 'ok',
        title: action.kind === 'merge' && action.auto ? 'Auto-merge enabled' : ACTION_DONE[action.kind],
      })
      if (action.kind === 'merge') {
        setLastMethod(action.method)
        try {
          localStorage.setItem(METHOD_KEY, action.method)
        } catch {}
      }
    } catch (err) {
      toast({
        tone: 'error',
        title: `Could not ${action.kind === 'merge' ? 'merge this pull request' : ACTION_DONE[action.kind].toLowerCase()}`,
        body: [err instanceof Error ? err.message : String(err), failureHint(action.kind)].filter(Boolean).join(' — '),
      })
    } finally {
      setBusy(null)
      onRefresh()
    }
  }

  if (!pr) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-2">
          <BackButton onBack={onBack} />
        </div>
        {error ? (
          <div className="m-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
            <button type="button" onClick={onRefresh} className="ml-2 underline">
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        )}
      </div>
    )
  }

  const control = primaryControl(pr)
  const method = chooseMergeMethod(pr, lastMethod)
  // The repo may delete merged branches itself; otherwise it's opt-in per merge.
  const willDeleteBranch = !pr.repo.deleteBranchOnMerge && (deleteBranch ?? false)
  const write = canWrite(pr.repo)
  const presentation = STATE_PRESENTATION[pr.state]
  const sessionId = sessionForBranch(pr.headRefName)
  const isOpen = pr.state === 'OPEN' || pr.state === 'DRAFT'

  const mergeAction = (auto: boolean): PullAction => ({ kind: 'merge', method, deleteBranch: willDeleteBranch && !auto, auto })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/60">
        <div className="flex h-10 items-center gap-1 pl-1 pr-2">
          <BackButton onBack={onBack} />
          <a
            href={pr.repo.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-xs font-medium text-muted-foreground hover:underline"
          >
            {pr.repo.nameWithOwner}
          </a>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className={cn('flex shrink-0 items-center gap-0.5 font-mono text-xs', presentation.className)}
          >
            #{pr.number}
            <ArrowUpRight aria-hidden className="size-3" />
          </a>
          <span className="flex-1" />
          {loading && <LoaderCircle aria-label="Refreshing" className="size-3.5 animate-spin text-muted-foreground" />}
          <div className="relative">
            <button
              type="button"
              aria-label="More actions"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground active:bg-accent"
            >
              <Ellipsis className="size-4" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-9 z-50 w-60 rounded-lg border border-border bg-popover p-1 text-sm shadow-xl">
                  {sessionId && (
                    <MenuItem icon={SquareTerminal} onClick={() => onOpenSession(sessionId)}>
                      Open the branch’s session
                    </MenuItem>
                  )}
                  <MenuItem icon={RefreshCw} onClick={() => (setMenuOpen(false), onRefresh())}>
                    Refresh
                  </MenuItem>
                  {isOpen && (
                    <>
                      <MenuSeparator />
                      {pr.state === 'DRAFT' && control !== 'ready' && (
                        <MenuItem icon={Check} onClick={() => act({ kind: 'ready' })}>
                          Ready for review
                        </MenuItem>
                      )}
                      {pr.state === 'OPEN' && (pr.viewerIsAuthor || write) && (
                        <MenuItem icon={GitBranch} onClick={() => act({ kind: 'draft' })}>
                          Convert to draft
                        </MenuItem>
                      )}
                      {write && pr.state === 'OPEN' && control === 'enable-auto-merge' && (
                        <ConfirmMenuItem
                          icon={GitMerge}
                          armed={confirm.armed === 'merge-now'}
                          onArm={() => confirm.arm('merge-now')}
                          onConfirm={() => act(mergeAction(false))}
                          confirmLabel="Confirm merge?"
                        >
                          Merge now
                        </ConfirmMenuItem>
                      )}
                      {pr.autoMerge ? (
                        <MenuItem icon={X} onClick={() => act({ kind: 'disableAutoMerge' })}>
                          Disable auto-merge
                        </MenuItem>
                      ) : (
                        write &&
                        pr.state === 'OPEN' &&
                        control === 'merge' &&
                        !immediatelyMergeable(pr.mergeStateStatus) && (
                          <MenuItem icon={GitMerge} onClick={() => act(mergeAction(true))}>
                            Enable auto-merge
                          </MenuItem>
                        )
                      )}
                      {pr.mergeStateStatus === 'BEHIND' && (
                        <MenuItem icon={RefreshCw} onClick={() => act({ kind: 'updateBranch' })}>
                          Update branch
                        </MenuItem>
                      )}
                      {write && pr.repo.mergeMethods.length > 1 && pr.state === 'OPEN' && pr.mergeable !== 'CONFLICTING' && (
                        <>
                          <MenuSeparator />
                          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground/70">Merge method</div>
                          {pr.repo.mergeMethods.map((m) => (
                            <MenuItem
                              key={m}
                              icon={m === method ? Check : undefined}
                              onClick={() => {
                                setLastMethod(m)
                                try {
                                  localStorage.setItem(METHOD_KEY, m)
                                } catch {}
                                setMenuOpen(false)
                              }}
                            >
                              {MERGE_METHOD_LABEL[m]}
                            </MenuItem>
                          ))}
                        </>
                      )}
                    </>
                  )}
                  <MenuSeparator />
                  <MenuItem icon={ArrowUpRight} onClick={() => (setMenuOpen(false), window.open(pr.url, '_blank', 'noopener'))}>
                    Open on GitHub
                  </MenuItem>
                  <MenuItem
                    icon={LinkIcon}
                    onClick={() => {
                      setMenuOpen(false)
                      void copyText(pr.url).then(() => toast({ tone: 'ok', title: 'Link copied' }))
                    }}
                  >
                    Copy link
                  </MenuItem>
                  <MenuItem
                    icon={Copy}
                    onClick={() => {
                      setMenuOpen(false)
                      void copyText(`#${pr.number}`).then(() => toast({ tone: 'ok', title: `Copied #${pr.number}` }))
                    }}
                  >
                    Copy PR number
                  </MenuItem>
                  {(pr.viewerIsAuthor || write) && (
                    <>
                      <MenuSeparator />
                      {isOpen ? (
                        <ConfirmMenuItem
                          icon={X}
                          destructive
                          armed={confirm.armed === 'close'}
                          onArm={() => confirm.arm('close')}
                          onConfirm={() => act({ kind: 'close' })}
                          confirmLabel="Confirm close?"
                        >
                          Close pull request
                        </ConfirmMenuItem>
                      ) : pr.state === 'CLOSED' ? (
                        <MenuItem icon={RefreshCw} onClick={() => act({ kind: 'reopen' })}>
                          Reopen pull request
                        </MenuItem>
                      ) : null}
                      {!isOpen && write && !pr.isCrossRepository && pr.headRefName !== pr.repo.defaultBranch && (
                        <MenuItem
                          icon={Trash2}
                          destructive
                          onClick={() => {
                            setMenuOpen(false)
                            setConfirmDelete(true)
                          }}
                        >
                          <span className="flex min-w-0 flex-col">
                            Delete branch
                            <span className="truncate font-mono text-[11px] opacity-70">{pr.headRefName}</span>
                          </span>
                        </MenuItem>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="px-4 pb-3">
          <h1 className="text-[17px] font-semibold leading-snug text-foreground">{pr.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-medium', presentation.className, 'border-current/30')}>
              <presentation.Icon aria-hidden className="size-3" />
              {presentation.label}
            </span>
            <Avatar user={pr.author} size={16} />
            <span className="font-medium text-foreground">{pr.author.login}</span>
            <span>·</span>
            <span>
              {pr.state === 'MERGED' && pr.mergedAt
                ? `merged ${relativeTime(pr.mergedAt, now)}${pr.mergedBy ? ` by ${pr.mergedBy.login}` : ''}`
                : `updated ${relativeTime(pr.updatedAt, now)}`}
            </span>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-muted-foreground/80">
              <span className="truncate">{pr.baseRefName}</span>
              <ArrowLeft aria-label="receives changes from" className="size-3 shrink-0" />
              <button
                type="button"
                title="Copy branch name"
                onClick={() => void copyText(pr.headRefName).then(() => toast({ tone: 'ok', title: 'Branch copied' }))}
                className="min-w-0 truncate text-left hover:text-foreground"
              >
                {pr.headRefName}
              </button>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <FileDiff aria-hidden className="size-3.5" />
              {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}
            </span>
            <DiffStat additions={pr.additions} deletions={pr.deletions} />
          </div>

          <PrimaryAction
            pr={pr}
            control={control}
            method={method}
            busy={busy}
            armed={confirm.armed}
            onArm={confirm.arm}
            onMerge={(auto) => act(mergeAction(auto))}
            onReady={() => act({ kind: 'ready' })}
            deleteBranch={willDeleteBranch}
            onDeleteBranch={setDeleteBranch}
          />
        </div>

        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
          <div className="flex rounded-lg border border-border bg-muted/30 p-0.5">
            {(['summary', 'timeline', 'code'] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  'h-7 rounded-md px-3 text-xs font-medium capitalize transition-colors',
                  tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
            {tab === 'summary' && (
              <>
                <ChecksIcon checks={pr.checks} />
                <span className="truncate">{checksSummaryText(pr.checks)}</span>
              </>
            )}
            {tab === 'timeline' && (
              <>
                <MessageSquare aria-hidden className="size-3.5" />
                {pr.timeline.filter((t) => t.kind === 'comment').length}
                <GitBranch aria-hidden className="ml-1 size-3.5" />
                {pr.commits}
              </>
            )}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === 'summary' && <SummaryTab pr={pr} now={now} />}
        {tab === 'timeline' && <TimelineTab pr={pr} now={now} />}
        {tab === 'code' && <PullRequestDiff rootDir={rootDir} number={pr.number} />}
      </div>

      <Composer pr={pr} busy={busy} onSubmit={act} />

      {confirmDelete && (
        <ConfirmSheet
          title={`Delete branch ${pr.headRefName}?`}
          body={
            <>
              This deletes <span className="font-mono text-foreground">{pr.headRefName}</span> from {pr.repo.nameWithOwner}.
              Local branches and worktrees are not changed.
            </>
          }
          confirmLabel="Delete branch"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void act({ kind: 'deleteBranch' })
          }}
        />
      )}
    </div>
  )
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      aria-label="Back to pull requests"
      onClick={onBack}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-accent lg:hidden"
    >
      <ArrowLeft className="size-4" />
    </button>
  )
}

// ── Primary action ───────────────────────────────────────────────────────

function PrimaryAction({
  pr,
  control,
  method,
  busy,
  armed,
  onArm,
  onMerge,
  onReady,
  deleteBranch,
  onDeleteBranch,
}: {
  pr: PullDetail
  control: ReturnType<typeof primaryControl>
  method: MergeMethod
  busy: PullAction['kind'] | null
  armed: string | null
  onArm: (key: string) => void
  onMerge: (auto: boolean) => void
  onReady: () => void
  deleteBranch: boolean
  onDeleteBranch: (v: boolean) => void
}) {
  if (!control) return null
  const base = 'mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-opacity disabled:opacity-60 active:opacity-80'

  if (control === 'merged' || control === 'closed') return null

  if (control === 'resolve') {
    return (
      <a href={`${pr.url}/conflicts`} target="_blank" rel="noreferrer" className={cn(base, 'border border-red-900/70 text-red-300')}>
        <TriangleAlert aria-hidden className="size-4" />
        Resolve conflicts
      </a>
    )
  }

  if (control === 'ready') {
    return (
      <button type="button" disabled={busy !== null} onClick={onReady} className={cn(base, 'bg-foreground text-background')}>
        {busy === 'ready' ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
        Ready for review
      </button>
    )
  }

  if (control === 'auto-merge-armed') {
    return (
      <div className={cn(base, 'border border-sky-900/70 bg-sky-950/40 text-sky-200')}>
        <GitMerge aria-hidden className="size-4" />
        Auto-merge ({MERGE_METHOD_LABEL[pr.autoMerge?.method ?? method].toLowerCase()})
      </div>
    )
  }

  const auto = control === 'enable-auto-merge'
  const key = auto ? 'auto' : 'merge'
  const isArmed = armed === key
  const label = auto ? `Auto-merge (${MERGE_METHOD_LABEL[method].toLowerCase()})` : MERGE_METHOD_LABEL[method]
  return (
    <div>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => (isArmed ? onMerge(auto) : onArm(key))}
        className={cn(
          base,
          isArmed ? 'bg-emerald-500 text-emerald-950' : auto ? 'border border-border bg-muted/40 text-foreground' : 'bg-emerald-600 text-white',
        )}
      >
        {busy === 'merge' ? (
          <>
            <LoaderCircle className="size-4 animate-spin" />
            {auto ? 'Enabling…' : 'Merging…'}
          </>
        ) : isArmed ? (
          <>
            <Check className="size-4" />
            {auto ? 'Confirm auto-merge?' : 'Confirm merge?'}
          </>
        ) : (
          <>
            <GitMerge className="size-4" />
            {label}
          </>
        )}
      </button>
      {!auto && !pr.isCrossRepository && !pr.repo.deleteBranchOnMerge && (
        <label className="mt-2 flex items-center gap-2 px-0.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={deleteBranch}
            onChange={(e) => onDeleteBranch(e.target.checked)}
            className="size-3.5 accent-emerald-500"
          />
          Delete <span className="truncate font-mono">{pr.headRefName}</span> on GitHub after merging
        </label>
      )}
      {auto && (
        <div className="mt-1.5 px-0.5 text-[11px] text-muted-foreground">
          {checksSummaryText(pr.checks)} — GitHub merges it once they pass.
        </div>
      )}
    </div>
  )
}

// ── Menu bits ────────────────────────────────────────────────────────────

function MenuItem({
  icon: Icon,
  destructive,
  onClick,
  children,
}: {
  icon?: typeof Check
  destructive?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left active:bg-accent hover:bg-accent/60',
        destructive ? 'text-red-300' : 'text-foreground',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{Icon && <Icon aria-hidden className="size-4" />}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

function ConfirmMenuItem({
  armed,
  onArm,
  onConfirm,
  confirmLabel,
  ...rest
}: {
  icon?: typeof Check
  destructive?: boolean
  armed: boolean
  onArm: () => void
  onConfirm: () => void
  confirmLabel: string
  children: React.ReactNode
}) {
  return (
    <MenuItem {...rest} icon={armed ? Check : rest.icon} onClick={armed ? onConfirm : onArm}>
      {armed ? <span className="font-medium">{confirmLabel}</span> : rest.children}
    </MenuItem>
  )
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-border/70" />
}

// ── Summary ──────────────────────────────────────────────────────────────

const REVIEW_RING: Record<string, string> = {
  APPROVED: 'ring-2 ring-emerald-500',
  CHANGES_REQUESTED: 'ring-2 ring-red-500',
  DISMISSED: 'ring-2 ring-muted-foreground/60',
  REQUESTED: 'ring-1 ring-dashed ring-muted-foreground/40',
}

function SummaryTab({ pr, now }: { pr: PullDetail; now: number }) {
  const [checksOpen, setChecksOpen] = useState(checksOverall(pr.checks) === 'failing')
  const [newestFirst, setNewestFirst] = useState(false)
  const comments = useMemo(() => {
    const list = pr.timeline.filter((t) => (t.kind === 'comment' || t.kind === 'review') && t.bodyHtml)
    return newestFirst ? [...list].reverse() : list
  }, [pr.timeline, newestFirst])

  return (
    <div className="space-y-5 px-4 py-4 pb-24">
      <div className="space-y-2.5 text-xs">
        <div className="flex items-center gap-3">
          <span className="flex w-20 shrink-0 items-center gap-1.5 text-muted-foreground">
            <Users aria-hidden className="size-3.5" />
            Reviewers
          </span>
          {pr.reviewers.length === 0 ? (
            <span className="text-muted-foreground/70">None</span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              {pr.reviewers.map((r) => (
                <span key={r.user.login} className="flex items-center gap-1.5" title={`${r.user.login}: ${r.state.toLowerCase().replace('_', ' ')}`}>
                  <Avatar user={r.user} size={18} className={REVIEW_RING[r.state]} />
                  <span className="text-foreground">{r.user.login}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex w-20 shrink-0 items-center gap-1.5 text-muted-foreground">
            <Tag aria-hidden className="size-3.5" />
            Labels
          </span>
          {pr.labels.length === 0 ? (
            <span className="text-muted-foreground/70">None</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {pr.labels.map((l) => (
                <LabelChip key={l.name} label={l} />
              ))}
            </span>
          )}
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Description</h2>
        {pr.bodyHtml ? (
          <div className="gh-markdown" dangerouslySetInnerHTML={{ __html: pr.bodyHtml }} />
        ) : (
          <p className="text-sm italic text-muted-foreground">No description provided.</p>
        )}
      </section>

      <section>
        <button
          type="button"
          onClick={() => setChecksOpen((o) => !o)}
          className="mb-1 flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
        >
          {checksOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Checks
          <span className="ml-1 flex items-center gap-1 font-normal">
            <ChecksIcon checks={pr.checks} />
            {checksSummaryText(pr.checks)}
          </span>
        </button>
        {checksOpen && <CheckList checks={pr.checkList} />}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">Comments ({comments.length})</h2>
          {comments.length > 1 && (
            <button type="button" onClick={() => setNewestFirst((v) => !v)} className="ml-auto text-xs text-muted-foreground">
              {newestFirst ? 'Newest first' : 'Oldest first'}
            </button>
          )}
        </div>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="space-y-3">
            {comments.map((c) => (
              <CommentCard key={c.id} item={c} now={now} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

const CHECK_ORDER: Record<string, number> = { fail: 0, action: 1, pending: 2, pass: 3, skipped: 4 }

function CheckList({ checks }: { checks: GitHubCheck[] }) {
  const [all, setAll] = useState(false)
  if (checks.length === 0) return <p className="px-2 py-2 text-sm text-muted-foreground">No checks reported.</p>
  const sorted = [...checks].sort((a, b) => CHECK_ORDER[a.bucket] - CHECK_ORDER[b.bucket] || a.name.localeCompare(b.name))
  const attention = sorted.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipped')
  const shown = all || attention.length === 0 ? sorted : attention
  return (
    <div>
      <ul>
        {shown.map((c) => (
          <li key={`${c.workflow}/${c.name}`}>
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-accent/60 active:bg-accent"
            >
              <CheckBucketIcon bucket={c.bucket} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {c.workflow && <span className="text-muted-foreground">{c.workflow} / </span>}
                {c.name}
              </span>
              <span className="shrink-0 text-muted-foreground">{CHECK_PRESENTATION[c.bucket].label}</span>
            </a>
          </li>
        ))}
      </ul>
      {shown.length < sorted.length || all ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="px-2 py-1 text-xs text-muted-foreground underline">
          {all ? 'Show less' : `Show all ${sorted.length}`}
        </button>
      ) : null}
    </div>
  )
}

const REVIEW_BADGE: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'Approved', className: 'border-emerald-800 text-emerald-300' },
  CHANGES_REQUESTED: { label: 'Changes requested', className: 'border-red-900 text-red-300' },
  DISMISSED: { label: 'Review dismissed', className: 'border-border text-muted-foreground' },
}

function CommentCard({ item, now }: { item: TimelineItem; now: number }) {
  const badge = item.reviewState ? REVIEW_BADGE[item.reviewState] : undefined
  return (
    <article className="rounded-lg border border-border/60 bg-background">
      <header className="flex items-center gap-1.5 rounded-t-lg bg-muted/25 px-3 py-2 text-xs">
        <Avatar user={item.actor} size={16} />
        <span className="font-medium text-foreground">{item.actor?.login ?? 'ghost'}</span>
        <a href={item.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline">
          {relativeTime(item.createdAt, now)}
        </a>
        {badge && <span className={cn('ml-auto rounded-full border px-1.5 py-px text-[10px]', badge.className)}>{badge.label}</span>}
      </header>
      <div className="gh-markdown px-3 py-3" dangerouslySetInnerHTML={{ __html: item.bodyHtml ?? '' }} />
    </article>
  )
}

// ── Timeline ─────────────────────────────────────────────────────────────

const EVENT_TEXT: Record<string, (detail?: string) => string> = {
  merged: () => 'merged this pull request',
  closed: () => 'closed this pull request',
  reopened: () => 'reopened this pull request',
  labeled: (d) => `added the ${d} label`,
  unlabeled: (d) => `removed the ${d} label`,
  review_requested: (d) => `requested a review from ${d}`,
  review_request_removed: (d) => `removed the review request for ${d}`,
  ready_for_review: () => 'marked this ready for review',
  convert_to_draft: () => 'converted this to a draft',
  head_ref_force_pushed: () => 'force-pushed the branch',
  head_ref_deleted: () => 'deleted the branch',
  renamed: (d) => `renamed this: ${d}`,
  auto_merge_enabled: () => 'enabled auto-merge',
  auto_merge_disabled: () => 'disabled auto-merge',
  assigned: (d) => (d ? `assigned ${d}` : 'was assigned'),
}

const REVIEW_VERB: Record<string, { text: string; className: string }> = {
  APPROVED: { text: 'approved these changes', className: 'text-emerald-400' },
  CHANGES_REQUESTED: { text: 'requested changes', className: 'text-red-400' },
  COMMENTED: { text: 'reviewed', className: 'text-muted-foreground' },
  DISMISSED: { text: 'review dismissed', className: 'text-muted-foreground' },
}

function TimelineTab({ pr, now }: { pr: PullDetail; now: number }) {
  if (pr.timeline.length === 0) {
    return <div className="px-4 py-16 text-center text-sm text-muted-foreground">No activity yet.</div>
  }
  return (
    <div className="relative mx-auto max-w-3xl px-4 py-4 pb-24">
      <span aria-hidden className="absolute bottom-4 left-[31px] top-4 w-px bg-border/45" />
      <ol>
        {pr.timeline.map((t) => (
          <li key={t.id} className="relative mb-4 pl-10">
            <span className="absolute left-[7px] top-0 flex size-[18px] items-center justify-center rounded-full bg-background">
              {t.kind === 'commit' ? (
                <GitBranch aria-hidden className="size-3.5 text-muted-foreground" />
              ) : t.kind === 'event' && t.event === 'merged' ? (
                <GitMerge aria-hidden className="size-3.5 text-violet-400" />
              ) : (
                <Avatar user={t.actor} size={18} />
              )}
            </span>
            {t.kind === 'commit' ? (
              <a href={t.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-foreground hover:text-sky-300">{t.detail}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{t.sha?.slice(0, 7)}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{relativeTime(t.createdAt, now)}</span>
              </a>
            ) : t.kind === 'event' ? (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t.actor?.login ?? 'Someone'}</span>{' '}
                {(EVENT_TEXT[t.event ?? ''] ?? (() => t.event ?? ''))(t.detail)} · {relativeTime(t.createdAt, now)}
              </div>
            ) : (
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{t.actor?.login ?? 'ghost'}</span>{' '}
                  {t.kind === 'review' ? (
                    <span className={REVIEW_VERB[t.reviewState ?? '']?.className}>
                      {REVIEW_VERB[t.reviewState ?? '']?.text ?? 'reviewed'}
                    </span>
                  ) : (
                    'commented'
                  )}{' '}
                  · {relativeTime(t.createdAt, now)}
                </div>
                {t.bodyHtml && (
                  <div className="gh-markdown rounded-lg border border-border/60 px-3 py-2.5" dangerouslySetInnerHTML={{ __html: t.bodyHtml }} />
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

// ── Composer ─────────────────────────────────────────────────────────────

type Verdict = 'comment' | 'approve' | 'requestChanges'

function Composer({
  pr,
  busy,
  onSubmit,
}: {
  pr: PullDetail
  busy: PullAction['kind'] | null
  onSubmit: (a: PullAction) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [modeChoice, setMode] = useState<'comment' | 'review'>('comment')
  const [verdict, setVerdict] = useState<Verdict>('approve')
  const [body, setBody] = useState('')

  // Authors can only comment on their own PR — GitHub refuses the rest.
  const canReview = !pr.viewerIsAuthor && (pr.state === 'OPEN' || pr.state === 'DRAFT')
  const mode = canReview ? modeChoice : 'comment'

  const submit = async () => {
    const text = body.trim()
    let action: PullAction
    if (mode === 'comment' || verdict === 'comment') {
      if (!text) return
      action = { kind: 'comment', body: text }
    } else if (verdict === 'approve') {
      action = { kind: 'approve', body: text }
    } else {
      if (!text) return
      action = { kind: 'requestChanges', body: text }
    }
    await onSubmit(action)
    setBody('')
    setOpen(false)
  }

  const sending = busy === 'comment' || busy === 'approve' || busy === 'requestChanges'
  const needsText = mode === 'comment' || verdict !== 'approve'

  return (
    <>
      {!open && (
        <button
          type="button"
          aria-label="Comment or review"
          onClick={() => setOpen(true)}
          className="absolute bottom-4 right-4 z-30 flex size-12 items-center justify-center rounded-full border border-border bg-popover/90 text-foreground shadow-xl backdrop-blur active:opacity-70"
        >
          <MessageSquare className="size-5" />
        </button>
      )}
      {open && (
        <div className="absolute inset-x-2 bottom-2 z-40 rounded-xl border border-border bg-popover p-3 shadow-2xl sm:left-auto sm:w-96">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex rounded-lg border border-border bg-muted/30 p-0.5">
              {(['comment', 'review'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={m === 'review' && !canReview}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'h-7 rounded-md px-3 text-xs font-medium capitalize disabled:opacity-40',
                    mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <button type="button" aria-label="Close composer" onClick={() => setOpen(false)} className="ml-auto text-muted-foreground">
              <X className="size-4" />
            </button>
          </div>
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={4}
            placeholder={mode === 'comment' ? 'Leave a comment' : 'Summarize your review (optional for approvals)'}
            className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-foreground/30"
          />
          <div className="mt-2 flex items-center gap-2">
            {mode === 'review' && (
              <select
                value={verdict}
                onChange={(e) => setVerdict(e.target.value as Verdict)}
                aria-label="Review verdict"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm"
              >
                <option value="approve">Approve</option>
                <option value="requestChanges">Request changes</option>
                <option value="comment">Comment</option>
              </select>
            )}
            <button
              type="button"
              disabled={sending || (needsText && !body.trim())}
              onClick={() => void submit()}
              className="ml-auto flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm font-medium text-background disabled:opacity-40"
            >
              {sending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              {mode === 'comment' ? 'Comment' : 'Submit review'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
