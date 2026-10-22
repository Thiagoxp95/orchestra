'use client'
// The Code tab: `gh pr diff`, one collapsible card per file, stacked layout
// with old/new line numbers — the phone-width reading of t3code's diff view.
// "Viewed" marks are kept per PR on this device.

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseDiff, type DiffFile } from '@/lib/github'
import { DiffStat } from './pr-ui'
import { usePullDiff } from './usePullRequests'

/** Files past this many lines start collapsed so a lockfile can't bury the rest. */
const AUTO_COLLAPSE_LINES = 400

function viewedKey(rootDir: string, number: number) {
  return `orchestra.pullRequests.viewed:${rootDir}#${number}`
}

function readViewed(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function PullRequestDiff({ rootDir, number }: { rootDir: string; number: number }) {
  const { data, error, loading, refresh } = usePullDiff(rootDir, number, true)
  const files = useMemo(() => (data ? parseDiff(data) : undefined), [data])
  const key = viewedKey(rootDir, number)
  const [viewed, setViewed] = useState(() => readViewed(key))
  const [wrap, setWrap] = useState(false)

  const toggleViewed = (path: string) => {
    setViewed((cur) => {
      const next = new Set(cur)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {}
      return next
    })
  }

  if (!files) {
    return error ? (
      <div className="m-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        {error}
        <button type="button" onClick={refresh} className="ml-2 underline">
          Retry
        </button>
      </div>
    ) : (
      <div className="flex justify-center py-16 text-muted-foreground">
        <LoaderCircle className={cn('size-5', loading && 'animate-spin')} />
      </div>
    )
  }
  if (files.length === 0) {
    return <div className="px-4 py-16 text-center text-sm text-muted-foreground">This pull request has no file changes.</div>
  }

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-10 flex h-10 items-center gap-3 border-b border-border/60 bg-background/95 px-4 text-xs text-muted-foreground backdrop-blur">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        <span>
          {files.filter((f) => viewed.has(f.path)).length} / {files.length} viewed
        </span>
        <label className="ml-auto flex items-center gap-1.5">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} className="size-3.5" />
          Wrap lines
        </label>
      </div>
      <div className="space-y-2 p-2">
        {files.map((f) => (
          <FileCard key={f.path} file={f} viewed={viewed.has(f.path)} onViewed={() => toggleViewed(f.path)} wrap={wrap} />
        ))}
      </div>
    </div>
  )
}

const STATUS_TAG: Partial<Record<DiffFile['status'], string>> = { added: 'new', deleted: 'deleted', renamed: 'renamed' }

function FileCard({ file, viewed, onViewed, wrap }: { file: DiffFile; viewed: boolean; onViewed: () => void; wrap: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (!viewed && file.lines.length <= AUTO_COLLAPSE_LINES)
  const slash = file.path.lastIndexOf('/')
  return (
    <section className="overflow-hidden rounded-lg border border-border/60">
      <header className="flex items-center gap-2 bg-muted/30 px-2 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate font-mono" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            <span className="text-muted-foreground">{slash >= 0 ? file.path.slice(0, slash + 1) : ''}</span>
            <span className="text-foreground">{file.path.slice(slash + 1)}</span>
          </span>
          {STATUS_TAG[file.status] && (
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">{STATUS_TAG[file.status]}</span>
          )}
        </button>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <label className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={viewed} onChange={onViewed} className="size-3.5" />
          Viewed
        </label>
      </header>
      {expanded &&
        (file.binary ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">Binary file not shown.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11px] leading-[18px]">
              <tbody>
                {file.lines.map((l, i) =>
                  l.kind === 'hunk' ? (
                    <tr key={i} className="bg-sky-950/30 text-sky-300/80">
                      <td colSpan={3} className="px-2 py-0.5">
                        {l.text}
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={i}
                      className={cn(l.kind === 'add' && 'bg-emerald-950/45', l.kind === 'del' && 'bg-red-950/45', l.kind === 'meta' && 'text-muted-foreground')}
                    >
                      <td className="w-8 select-none px-1 text-right align-top text-muted-foreground/50">{l.oldNo ?? ''}</td>
                      <td className="w-8 select-none px-1 text-right align-top text-muted-foreground/50">{l.newNo ?? ''}</td>
                      <td className={cn('px-2 align-top text-foreground/90', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                        <span
                          className={cn(
                            'mr-1 select-none',
                            l.kind === 'add' ? 'text-emerald-400' : l.kind === 'del' ? 'text-red-400' : 'text-transparent',
                          )}
                        >
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                        </span>
                        {l.text}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
}
