'use client'
// The pull-request list, after t3code's: involvement and state filters, a
// search that GitHub runs and this page re-ranks, grouping into Authored /
// Review requested / Others, and two-line rows sorted by merge readiness.

import { useMemo, useState } from 'react'
import { ArrowDownUp, Eye, GitPullRequestArrow, Layers, PenLine, RefreshCw, Search, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  GROUP_LABEL,
  SORT_LABEL,
  groupPulls,
  relativeTime,
  searchScore,
  sortPulls,
  type Involvement,
  type PullGroupKey,
  type PullSort,
  type PullSummary,
  type StateFilter,
  type GitHubUser,
  authorKey,
} from '@/lib/github'
import { Avatar, ChecksIcon, DiffStat, LabelChip, PullStateIcon, ReviewIcon } from './pr-ui'
import { AuthorFilter } from './AuthorFilter'

const INVOLVEMENT: { value: Involvement; label: string; Icon: typeof Eye }[] = [
  { value: 'all', label: 'All', Icon: Layers },
  { value: 'reviewing', label: 'Reviewing', Icon: Eye },
  { value: 'authored', label: 'Authored', Icon: PenLine },
]

const STATES: { value: StateFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

const GROUP_ICON: Record<PullGroupKey, typeof Eye> = { authored: PenLine, reviewRequested: Eye, others: Users }

export interface ListFilter {
  state: StateFilter
  involvement: Involvement
  sort: PullSort
  query: string
  /** Author keys (see authorKey); empty = anyone. GitHub ORs them. */
  authors: string[]
}

export function PullRequestList({
  pulls,
  viewer,
  authorOptions,
  filter,
  onFilter,
  searchDraft,
  onSearchDraft,
  loading,
  error,
  onRefresh,
  selected,
  onOpen,
  now,
}: {
  pulls: PullSummary[] | undefined
  viewer: string
  authorOptions: GitHubUser[]
  filter: ListFilter
  onFilter: (patch: Partial<ListFilter>) => void
  searchDraft: string
  onSearchDraft: (q: string) => void
  loading: boolean
  error: string | null
  onRefresh: () => void
  selected?: number
  onOpen: (number: number) => void
  now: number
}) {
  const [sortOpen, setSortOpen] = useState(false)
  const authorCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of pulls ?? []) counts.set(authorKey(p.author), (counts.get(authorKey(p.author)) ?? 0) + 1)
    return counts
  }, [pulls])

  const groups = useMemo(() => {
    if (!pulls) return []
    // While searching, GitHub's hits are re-ranked locally instead of sorted.
    const list = filter.query
      ? pulls
          .map((p) => ({ p, score: searchScore(p, filter.query) }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.p)
      : sortPulls(pulls, filter.sort, viewer)
    return groupPulls(list, viewer, filter.involvement)
  }, [pulls, filter.query, filter.sort, filter.involvement, viewer])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onFilter({ query: searchDraft.trim() })
          }}
        >
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 text-sm">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              enterKeyHint="search"
              value={searchDraft}
              onChange={(e) => onSearchDraft(e.target.value)}
              placeholder="Search pull requests, or label:bug"
              aria-label="Search pull requests"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
            />
            {(searchDraft || filter.query) && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  onSearchDraft('')
                  onFilter({ query: '' })
                }}
                className="text-muted-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </label>
          <div className="relative">
            <button
              type="button"
              aria-label="Sort"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((o) => !o)}
              className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground active:bg-accent"
            >
              <ArrowDownUp className="size-4" />
            </button>
            {sortOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                <div className="absolute right-0 top-10 z-50 w-48 rounded-lg border border-border bg-popover p-1 shadow-xl">
                  {(Object.keys(SORT_LABEL) as PullSort[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        onFilter({ sort: s })
                        setSortOpen(false)
                      }}
                      className={cn(
                        'flex w-full rounded-md px-2.5 py-2 text-left text-sm active:bg-accent',
                        filter.sort === s ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {SORT_LABEL[s]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            aria-label="Refresh pull requests"
            onClick={onRefresh}
            className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground active:bg-accent"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </button>
        </form>
        <div className="flex items-center gap-2 overflow-x-auto">
          <Segmented
            value={filter.involvement}
            options={INVOLVEMENT.map(({ value, label, Icon }) => ({
              value,
              label: (
                <>
                  <Icon aria-hidden className="size-3.5" />
                  {label}
                </>
              ),
            }))}
            onChange={(involvement) => onFilter({ involvement })}
          />
          <Segmented
            value={filter.state}
            options={STATES.map(({ value, label }) => ({ value, label }))}
            onChange={(state) => onFilter({ state })}
          />
          <AuthorFilter
            authors={authorOptions}
            counts={authorCounts}
            selected={filter.authors}
            viewer={viewer}
            onChange={(authors) => onFilter({ authors })}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-2">
        {error && (
          <div className="mx-1.5 mb-2 flex items-center gap-2 rounded-lg border border-amber-900/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            <span className="min-w-0 flex-1">
              {error}
              {pulls ? ' Showing the last pull requests loaded.' : ''}
            </span>
            <button type="button" onClick={onRefresh} className="shrink-0 font-medium underline">
              Retry
            </button>
          </div>
        )}
        {!pulls && !error && <ListGhost />}
        {pulls && groups.length === 0 && (
          <EmptyState
            query={filter.query}
            filtered={filter.state !== 'all' || filter.involvement !== 'all' || filter.authors.length > 0}
            onClear={() => {
              onSearchDraft('')
              onFilter({ query: '' })
            }}
          />
        )}
        <div className="space-y-3">
          {groups.map((g) => {
            const Icon = g.key ? GROUP_ICON[g.key] : null
            return (
              <section key={g.key ?? 'all'}>
                {g.key && Icon && (
                  <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
                    <Icon aria-hidden className="size-3.5" />
                    <h2>{GROUP_LABEL[g.key]}</h2>
                    <span className="tabular-nums text-muted-foreground/50">{g.pulls.length}</span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                )}
                <ul className="space-y-0.5">
                  {g.pulls.map((pr) => (
                    <PullRow key={pr.number} pr={pr} selected={pr.number === selected} onOpen={onOpen} now={now} />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: React.ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex shrink-0 rounded-lg border border-border bg-muted/30 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors',
            o.value === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function PullRow({
  pr,
  selected,
  onOpen,
  now,
}: {
  pr: PullSummary
  selected: boolean
  onOpen: (n: number) => void
  now: number
}) {
  const shown = pr.labels.slice(0, 3)
  const extra = pr.labels.length - shown.length
  return (
    <li className={cn('flex items-center rounded-md', selected ? 'bg-accent' : 'active:bg-accent/60 hover:bg-accent/60')}>
      <button
        type="button"
        onClick={() => onOpen(pr.number)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2.5 text-left"
      >
        <span className="flex w-4 shrink-0 justify-center self-start pt-0.5">
          <PullStateIcon state={pr.state} conflicting={pr.mergeable === 'CONFLICTING'} baseRefName={pr.baseRefName} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">#{pr.number}</span>
            <span className="min-w-0 truncate text-sm text-foreground">{pr.title}</span>
            <span className="flex shrink-0 items-center gap-1">
              <ChecksIcon checks={pr.checks} />
              <ReviewIcon decision={pr.reviewDecision} />
            </span>
            <DiffStat additions={pr.additions} deletions={pr.deletions} className="ml-auto pl-1" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Avatar user={pr.author} size={14} />
            <span className="max-w-[40%] shrink truncate">{pr.author.login}</span>
            {shown.map((l) => (
              <LabelChip key={l.name} label={l} />
            ))}
            {extra > 0 && <span className="shrink-0">+{extra}</span>}
            <span className="ml-auto shrink-0 tabular-nums">{relativeTime(pr.updatedAt, now)}</span>
          </span>
        </span>
      </button>
    </li>
  )
}

function ListGhost() {
  return (
    <ul className="space-y-0.5" aria-label="Loading pull requests">
      {Array.from({ length: 7 }, (_, i) => (
        <li key={i} className="flex items-center gap-2 px-3 py-2.5">
          <span className="size-4 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
            <span className="h-2.5 w-1/3 animate-pulse rounded bg-muted/70" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({ query, filtered, onClear }: { query: string; filtered: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <GitPullRequestArrow aria-hidden className="mb-3 size-8 text-muted-foreground/40" />
      <div className="text-sm font-medium text-foreground">
        {query ? `Nothing matches “${query}”` : filtered ? 'Nothing under these filters' : 'No pull requests'}
      </div>
      <div className="mt-1 max-w-xs text-xs leading-snug text-muted-foreground">
        {query
          ? 'GitHub was searched for it. Try fewer words, or search by number, author or branch.'
          : filtered
            ? 'Widen the state, involvement or author filter to see more.'
            : 'Pull requests for this repository appear here.'}
      </div>
      {query && (
        <button type="button" onClick={onClear} className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs">
          Clear search
        </button>
      )}
    </div>
  )
}
