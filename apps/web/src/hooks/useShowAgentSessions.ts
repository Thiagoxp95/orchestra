import { useSyncExternalStore } from 'react'
import { getShowAgentSessions, subscribeShowAgentSessions, writeShowAgentSessions } from '../lib/agent-sessions'

/** The "Show agent sessions" toggle: one value shared by the drawer and the overview. */
export function useShowAgentSessions(): [boolean, (show: boolean) => void] {
  const show = useSyncExternalStore(subscribeShowAgentSessions, getShowAgentSessions, () => false)
  return [show, writeShowAgentSessions]
}
