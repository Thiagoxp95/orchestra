import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { PendingEcho } from './chat-messages'
import { getEchoSnapshot, subscribeEchoes, updateEchoes } from './pending-echoes'

const SERVER_SNAPSHOT: PendingEcho[] = []

export function usePendingEchoes(
  sessionId: string,
): [PendingEcho[], Dispatch<SetStateAction<PendingEcho[]>>] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeEchoes(sessionId, listener),
    [sessionId],
  )
  const getSnapshot = useCallback(() => getEchoSnapshot(sessionId), [sessionId])
  const echoes = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT)
  const setEchoes = useCallback<Dispatch<SetStateAction<PendingEcho[]>>>(
    (action) => {
      updateEchoes(sessionId, (current) =>
        typeof action === 'function' ? action(current) : action,
      )
    },
    [sessionId],
  )
  return [echoes, setEchoes]
}
