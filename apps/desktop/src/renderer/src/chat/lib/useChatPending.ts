import { useCallback, useSyncExternalStore } from 'react'
import { pendingChatCommands } from '../../../../shared/pending-chat-commands'

export function useChatPending(sessionId: string, kind: 'send' | 'model') {
  const key = `${kind}:${sessionId}`
  const busy = useSyncExternalStore(
    useCallback((listener: () => void) => pendingChatCommands.subscribe(key, listener), [key]),
    useCallback(() => pendingChatCommands.has(key), [key]),
    () => false,
  )
  return { busy, start: () => pendingChatCommands.start(key) }
}
