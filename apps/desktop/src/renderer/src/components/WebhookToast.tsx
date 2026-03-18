import { useState } from 'react'
import { isLightColor } from '../utils/color'
import type { WebhookEventToast } from '../../../shared/types'

export interface WebhookToastEntry extends WebhookEventToast {
  id: string
  fadingOut: boolean
  expanded: boolean
}

interface WebhookToastContainerProps {
  toasts: WebhookToastEntry[]
  onDismiss: (id: string) => void
  onToggleExpand: (id: string) => void
}

export function WebhookToastContainer({ toasts, onDismiss, onToggleExpand }: WebhookToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none items-center">
      {toasts.map((t) => (
        <WebhookToastItem
          key={t.id}
          entry={t}
          onDismiss={() => onDismiss(t.id)}
          onToggleExpand={() => onToggleExpand(t.id)}
        />
      ))}
    </div>
  )
}

function WebhookToastItem({
  entry,
  onDismiss,
  onToggleExpand,
}: {
  entry: WebhookToastEntry
  onDismiss: () => void
  onToggleExpand: () => void
}) {
  const [copied, setCopied] = useState(false)
  const bg = entry.workspaceColor || '#1a1a2e'
  const light = isLightColor(bg)
  const textPrimary = light ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)'
  const textSecondary = light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
  const borderColor = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.1)'
  const badgeColor = entry.filterPassed ? '#4ade80' : '#fbbf24'
  const badgeText = entry.filterPassed ? 'Triggered' : 'Filtered'
  const reasonText = entry.filterResult
    ? (entry.filterResult.length > 80 && !entry.expanded
      ? entry.filterResult.slice(0, 80) + '...'
      : entry.filterResult)
    : null

  const payloadStr = typeof entry.payload === 'string'
    ? entry.payload
    : JSON.stringify(entry.payload, null, 2)

  const handleCopyPayload = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(payloadStr ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={`pointer-events-auto rounded-xl shadow-lg transition-all duration-300
        ${entry.fadingOut ? 'opacity-0 -translate-y-4' : 'opacity-100 translate-y-0 animate-toast-in'}`}
      style={{ backgroundColor: bg, border: `1px solid ${borderColor}`, maxWidth: '560px', minWidth: '340px' }}
    >
      {/* Collapsed header — always visible */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 px-4 py-3 cursor-pointer hover:brightness-110 transition-all"
      >
        {/* Workspace color dot */}
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: entry.workspaceColor }}
        />

        {/* Action name */}
        <span className="text-[13px] font-semibold truncate" style={{ color: textPrimary }}>
          {entry.actionName}
        </span>

        {/* Pass/fail badge */}
        <span
          className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
          style={{ backgroundColor: `${badgeColor}22`, color: badgeColor }}
        >
          {badgeText}
        </span>

        {/* LLM reason (truncated) */}
        {reasonText && (
          <span className="text-[11px] truncate ml-auto" style={{ color: textSecondary }}>
            {reasonText}
          </span>
        )}

        {/* Chevron */}
        <span
          className="text-[11px] shrink-0 transition-transform duration-200"
          style={{ color: textSecondary, transform: entry.expanded ? 'rotate(180deg)' : undefined }}
        >
          ▼
        </span>

        {/* Dismiss X */}
        <span
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          className="text-[11px] shrink-0 opacity-40 hover:opacity-100 transition-opacity ml-1"
          style={{ color: textPrimary }}
        >
          ✕
        </span>
      </button>

      {/* Expanded content */}
      {entry.expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3" style={{ borderTop: `1px solid ${borderColor}` }}>
          {/* Workspace info */}
          <div className="pt-3 flex items-center gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: textSecondary }}>
              {entry.workspaceName}
            </span>
            <span className="text-[9px]" style={{ color: textSecondary }}>
              {new Date(entry.createdAt).toLocaleTimeString()}
            </span>
          </div>

          {/* Filter prompt */}
          {entry.filterPrompt && (
            <div>
              <span className="text-[9px] font-semibold uppercase tracking-wider block mb-1" style={{ color: textSecondary }}>
                Filter Prompt
              </span>
              <div
                className="text-[11px] font-mono leading-snug px-3 py-2 rounded-lg"
                style={{ color: textPrimary, backgroundColor: `${textPrimary}08`, border: `1px solid ${borderColor}` }}
              >
                {entry.filterPrompt}
              </div>
            </div>
          )}

          {/* LLM reasoning */}
          {entry.filterResult && (
            <div>
              <span className="text-[9px] font-semibold uppercase tracking-wider block mb-1" style={{ color: badgeColor }}>
                LLM Reasoning
              </span>
              <div className="text-[11px] leading-snug" style={{ color: textPrimary }}>
                {entry.filterResult}
              </div>
            </div>
          )}

          {/* Payload */}
          {entry.payload != null && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: textSecondary }}>
                  Payload
                </span>
                <button
                  onClick={handleCopyPayload}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded hover:brightness-125 transition-all cursor-pointer"
                  style={{ color: textSecondary, backgroundColor: `${textPrimary}08` }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre
                className="text-[10px] font-mono leading-snug px-3 py-2 rounded-lg overflow-auto whitespace-pre-wrap break-all"
                style={{
                  color: textPrimary,
                  backgroundColor: `${textPrimary}05`,
                  border: `1px solid ${borderColor}`,
                  maxHeight: '200px',
                }}
              >
                {payloadStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
