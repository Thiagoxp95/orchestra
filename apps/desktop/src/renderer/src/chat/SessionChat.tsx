import { ChatOverlay, useChatView } from '@chat'
import { desktopChatTransport, useAgentContext } from './desktop-transport'

/** The chat overlay for one terminal pane (mounted beside its TerminalInstance). */
export function SessionChat({ sessionId, color, surface, active }: {
  sessionId: string
  color?: string
  surface?: string
  active: boolean
}) {
  const inChat = useChatView(desktopChatTransport, sessionId) === 'chat'
  const context = useAgentContext(sessionId, inChat && active)
  return (
    <ChatOverlay
      sessionId={sessionId}
      transport={desktopChatTransport}
      color={color}
      surface={surface}
      context={context}
      active={active}
    />
  )
}
