'use client'
// The list's author filter, t3code's "Author" menu made multi-select: pick any
// number of people and the list shows PRs by any of them. Portaled, because the
// filter row scrolls sideways on a phone and would clip a dropdown inside it.

import { useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { authorKey, type GitHubUser } from '@/lib/github'
import { Portal } from '../Portal'
import { Avatar } from './pr-ui'

export function AuthorFilter({
  authors,
  counts,
  selected,
  viewer,
  onChange,
}: {
  /** Everyone to offer, most recently seen first. */
  authors: GitHubUser[]
  /** PRs per author key in the list on screen. */
  counts: Map<string, number>
  /** Selected author keys; empty = anyone. */
  selected: string[]
  viewer: string
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const place = () => {
      const r = button.current!.getBoundingClientRect()
      const width = Math.min(288, window.innerWidth - 16)
      setAnchor({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  const chosen = new Set(selected)
  const q = query.trim().toLowerCase()
  // Selected first, then you, then by how many PRs they have on screen.
  const options = authors
    .filter((u) => !q || u.login.toLowerCase().includes(q) || u.name?.toLowerCase().includes(q))
    .sort((a, b) => {
      const ka = authorKey(a)
      const kb = authorKey(b)
      return (
        Number(chosen.has(kb)) - Number(chosen.has(ka)) ||
        Number(b.login === viewer) - Number(a.login === viewer) ||
        (counts.get(kb) ?? 0) - (counts.get(ka) ?? 0) ||
        a.login.localeCompare(b.login)
      )
    })

  const toggle = (key: string) => onChange(chosen.has(key) ? selected.filter((k) => k !== key) : [...selected, key])
  const picked = authors.filter((u) => chosen.has(authorKey(u)))

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
          selected.length ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border bg-muted/30 text-muted-foreground',
        )}
      >
        {picked.length > 0 ? (
          <span className="flex -space-x-1">
            {picked.slice(0, 3).map((u) => (
              <Avatar key={authorKey(u)} user={u} size={16} className="ring-1 ring-background" />
            ))}
          </span>
        ) : (
          <UserRound aria-hidden className="size-3.5" />
        )}
        {selected.length === 0
          ? 'Author'
          : selected.length === 1
            ? (picked[0]?.login ?? selected[0].replace(/^app\//, ''))
            : `${selected.length} authors`}
        <ChevronDown aria-hidden className="size-3.5 opacity-70" />
      </button>
      {open && anchor && (
        <Portal>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label="Filter by author"
            style={{ top: anchor.top, left: anchor.left }}
            className="fixed z-50 flex max-h-[min(24rem,70vh)] w-[min(18rem,calc(100vw-1rem))] flex-col rounded-lg border border-border bg-popover shadow-2xl"
          >
            <label className="flex shrink-0 items-center gap-2 border-b border-border/70 px-2.5 py-2 text-sm">
              <Search aria-hidden className="size-4 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search authors"
                aria-label="Search authors"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              <Option checked={selected.length === 0} onClick={() => onChange([])}>
                <span className="flex size-[18px] items-center justify-center">
                  <UserRound aria-hidden className="size-4 text-muted-foreground" />
                </span>
                <span className="flex-1">Anyone</span>
              </Option>
              {options.map((u) => {
                const key = authorKey(u)
                return (
                  <Option key={key} checked={chosen.has(key)} onClick={() => toggle(key)}>
                    <Avatar user={u} size={18} />
                    <span className="min-w-0 flex-1 truncate">
                      {u.login}
                      {u.login === viewer && <span className="text-muted-foreground"> (you)</span>}
                      {u.isBot && <span className="text-muted-foreground"> bot</span>}
                    </span>
                    {counts.get(key) ? (
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{counts.get(key)}</span>
                    ) : null}
                  </Option>
                )
              })}
              {options.length === 0 && <div className="px-2.5 py-3 text-xs text-muted-foreground">No one matches.</div>}
            </div>
          </div>
        </Portal>
      )}
    </>
  )
}

function Option({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground hover:bg-accent/60 active:bg-accent"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked && <Check aria-hidden className="size-4" />}
      </span>
      {children}
    </button>
  )
}
