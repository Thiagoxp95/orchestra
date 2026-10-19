import { Bot } from 'lucide-react'

/**
 * The bot mark on a session an agent opened through Orchestra's MCP server
 * (origin 'mcp'), so it never passes for one you opened yourself. Always
 * visible, never behind a hover — the phone wears the same mark.
 */
export function AgentOriginMark({ color, size = 13, className = '' }: { color: string; size?: number; className?: string }) {
  return (
    <span role="img" aria-label="Opened by an agent" title="Opened by an agent" className={`inline-flex shrink-0 ${className}`}>
      <Bot size={size} color={color} strokeWidth={2.25} aria-hidden />
    </span>
  )
}

/**
 * The same mark as a corner badge on a session icon, for the collapsed sidebar
 * where there is no label to sit beside. Bottom-right, so it never fights the
 * attention dot in the top-right corner.
 */
export function AgentOriginBadge({ color, ring }: { color: string; ring: string }) {
  return (
    <span
      aria-hidden
      className="absolute -right-1.5 -bottom-1 inline-flex items-center justify-center rounded-full"
      style={{ width: 12, height: 12, backgroundColor: color, boxShadow: `0 0 0 1.5px ${ring}` }}
    >
      <Bot size={9} color={ring} strokeWidth={2.75} />
    </span>
  )
}
