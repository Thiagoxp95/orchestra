// Extracts terminal title from OSC 0/2 escape sequences in raw pty data.
// Tracks whether the title is actively animating (changing rapidly).

const TITLE_ANIMATION_WINDOW_MS = 1_000

// Matches OSC 0 or 2 terminated by BEL (\x07) or ST (\x1b\\)
const OSC_TITLE_RE = /\x1b\]([02]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g

interface TitleState {
  lastTitle: string
  prevTitle: string
  lastChangeAt: number
}

const sessions = new Map<string, TitleState>()

function getOrCreate(sessionId: string): TitleState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { lastTitle: '', prevTitle: '', lastChangeAt: 0 }
    sessions.set(sessionId, state)
  }
  return state
}

export function feedRawData(sessionId: string, rawData: string): void {
  const state = getOrCreate(sessionId)

  let match: RegExpExecArray | null
  OSC_TITLE_RE.lastIndex = 0
  while ((match = OSC_TITLE_RE.exec(rawData)) !== null) {
    const title = match[2]
    if (title !== state.lastTitle) {
      state.prevTitle = state.lastTitle
      state.lastTitle = title
      state.lastChangeAt = Date.now()
    }
  }
}

export function isTitleAnimating(sessionId: string): boolean {
  const state = sessions.get(sessionId)
  if (!state) return false
  // Title is "animating" if it has changed from a non-empty previous value recently
  if (state.prevTitle === '') return false
  return Date.now() - state.lastChangeAt < TITLE_ANIMATION_WINDOW_MS
}

export function getLastTitle(sessionId: string): string {
  return sessions.get(sessionId)?.lastTitle ?? ''
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function clearAll(): void {
  sessions.clear()
}
