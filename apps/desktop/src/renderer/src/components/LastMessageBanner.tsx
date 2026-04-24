import { useState } from 'react'
import { useLastMessageStore } from '../stores/lastMessageStore'

interface Props {
  sessionId: string
  accentColor?: string
}

export function LastMessageBanner({ sessionId, accentColor }: Props) {
  const entry = useLastMessageStore((s) => s.bySession[sessionId])
  const [expanded, setExpanded] = useState(false)
  if (!entry) return null

  const bg = accentColor ? `${accentColor}22` : 'rgba(255,255,255,0.04)'
  const border = accentColor ? `${accentColor}55` : 'rgba(255,255,255,0.08)'

  return (
    <button
      type="button"
      role="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      title={entry.text}
      className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 border-b cursor-pointer"
      style={{ background: bg, borderColor: border }}
    >
      <span className="opacity-60 mr-2">you said:</span>
      <span
        className={expanded ? 'whitespace-pre-wrap block max-h-32 overflow-y-auto' : 'truncate inline-block align-bottom max-w-[calc(100%-5rem)]'}
      >
        {entry.text}
      </span>
    </button>
  )
}
