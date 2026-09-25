'use client'
import { createElement, memo, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  FileText,
  Globe,
  ListChecks,
  MessageCircle,
  Minus,
  Search,
  SquarePen,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react'
import { cn } from './cn'
import { firstLine, type WorkEntry } from './chat-timeline'

// Compact t3-style tool/thinking row: icon + heading + gray preview + status
// badge, expandable to a mono <pre> of the full output. Expansion is local
// state by design — it resets on the pane's foreground remount, which is fine
// for a "peek at the output" affordance.

type LucideIcon = typeof Wrench

function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell')) return SquareTerminal
  if (n === 'read') return Eye
  if (n === 'write' || n.includes('edit')) return SquarePen
  if (n === 'grep' || n === 'glob') return Search
  if (n.includes('webfetch') || n.includes('websearch') || n.includes('web_search')) return Globe
  if (n === 'task' || n.includes('agent')) return Bot
  if (n === 'todowrite') return ListChecks
  if (n.includes('question')) return MessageCircle
  return Wrench
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

const stop = (e: SyntheticEvent) => e.stopPropagation()

export const WorkRow = memo(function WorkRow({ entry }: { entry: WorkEntry }) {
  const [expanded, setExpanded] = useState(false)

  const thinking = entry.tone === 'thinking'
  const prose = entry.tone === 'text'
  const icon: LucideIcon = thinking ? Bot : prose ? FileText : toolIcon(entry.name ?? '')
  const heading = thinking ? 'Thinking' : prose ? 'Report' : capitalize(entry.name ?? 'Tool')
  const preview = thinking || prose ? firstLine(entry.text ?? '') : (entry.input ?? '')
  const body = thinking || prose ? (entry.text ?? '') : (entry.result?.output ?? '')
  // A Task row's subagent transcript: its own rows, nested under this one.
  const children = entry.children ?? []
  const expandable = body.trim().length > 0 || children.length > 0

  const toggle = () => setExpanded((v) => !v)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col rounded-md px-0.5 py-0.5 transition-colors',
        expandable &&
          // bg-surface-hover, not bg-accent/20: workspace tinting makes --accent
          // itself translucent, and stacking a /20 modifier on it multiplies the
          // alphas into invisibility.
          'cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
      )}
      {...(expandable
        ? { role: 'button', tabIndex: 0, onClick: toggle, onKeyDown }
        : null)}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
          {createElement(icon, { className: 'block size-3.5 shrink-0 stroke-[1.8] opacity-80' })}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex w-full min-w-0 items-baseline gap-1.5 text-[12px] leading-5">
              <span className="min-w-0 shrink truncate font-medium text-foreground/80">{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
          </div>
          {children.length > 0 && (
            <span className="shrink-0 rounded-full bg-surface-hover px-1.5 text-[10px] leading-4 text-muted-foreground/70">
              {children.length} {children.length === 1 ? 'step' : 'steps'}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {expandable && (
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 opacity-70 transition-transform duration-200',
                    expanded && 'rotate-180',
                  )}
                />
              )}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {entry.status === 'failed' ? (
                <span title="Failed">
                  <X className="block size-3 shrink-0 text-destructive" />
                </span>
              ) : entry.status === 'success' ? (
                <span title="Completed">
                  <Check className="block size-3 shrink-0 stroke-current" />
                </span>
              ) : entry.status === 'neutral' ? (
                <span title="Empty">
                  <Minus className="block size-3 shrink-0 opacity-70" />
                </span>
              ) : null /* running: liveness belongs to the timeline's working row */}
            </span>
          </div>
        </div>
      </div>
      {expanded && expandable && (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stop}
          onPointerDown={stop}
        >
          {children.map((child) => (
            <WorkRow key={child.id} entry={child} />
          ))}
          {body.trim().length > 0 && (
            <pre className="slim-scrollbar max-h-64 cursor-text select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
              {body}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})
