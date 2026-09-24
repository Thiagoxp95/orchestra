'use client'
import { ChatPane } from './ChatPane'
import type { ChatContextUsage, ChatDictation, ChatTransport } from './transport'
import { useChatView } from './ViewToggle'

/**
 * The chat laid over a session's terminal while its view is 'chat'. The
 * terminal underneath stays mounted exactly as it is — this only covers it.
 */
export function ChatOverlay({
  sessionId,
  transport,
  color,
  surface,
  context,
  active,
  dictation,
}: {
  sessionId: string
  transport: ChatTransport
  color?: string
  surface?: string
  context?: ChatContextUsage | null
  active?: boolean
  dictation?: ChatDictation
}) {
  if (useChatView(transport, sessionId) !== 'chat') return null
  return (
    <div className="absolute inset-0 z-20">
      <ChatPane
        sessionId={sessionId}
        transport={transport}
        color={color}
        surface={surface}
        context={context}
        active={active}
        dictation={dictation}
      />
    </div>
  )
}
