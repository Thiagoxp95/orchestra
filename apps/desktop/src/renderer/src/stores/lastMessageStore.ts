import { create } from 'zustand'
import type { LastUserMessageEvent } from '../../../shared/types'

interface LastMessageState {
  bySession: Record<string, { text: string; timestamp: number }>
  set: (event: LastUserMessageEvent) => void
  clear: (sessionId: string) => void
}

export const useLastMessageStore = create<LastMessageState>((set) => ({
  bySession: {},
  set: (event) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [event.sessionId]: { text: event.text, timestamp: event.timestamp },
      },
    })),
  clear: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.bySession
      return { bySession: rest }
    }),
}))
