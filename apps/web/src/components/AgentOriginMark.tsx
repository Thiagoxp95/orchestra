import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The bot mark on a session an agent opened through the desktop's MCP server
 * (origin 'mcp'), so it never passes for one you opened yourself. Always
 * visible, never behind a hover — the desktop sidebar wears the same mark.
 */
export function AgentOriginMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span role="img" aria-label="Opened by an agent" title="Opened by an agent" className={cn('inline-flex shrink-0', className)}>
      <Bot size={size} strokeWidth={2.25} aria-hidden />
    </span>
  )
}
