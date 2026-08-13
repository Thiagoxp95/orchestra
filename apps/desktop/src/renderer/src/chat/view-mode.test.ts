import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isAgentSession } from './lib/agent-session'
import { isChatAvailable } from './view-mode'

// The suite runs in node (no jsdom in this workspace), and loadViewMode only
// ever touches window.localStorage — so a two-method stand-in is the whole DOM
// this test needs.
const store = new Map<string, string>()
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  clear: () => store.clear(),
}
Object.defineProperty(globalThis, 'window', {
  value: { localStorage, addEventListener: () => {}, removeEventListener: () => {} },
  writable: true,
})

// SessionChat pulls in the whole chat pane (shiki, IPC-backed hooks); only the
// stored-preference reader is under test, so the module is imported lazily after
// localStorage is primed and the heavy children are stubbed out.
vi.mock('./ChatPane', () => ({ ChatPane: () => null }))

async function loadViewMode() {
  const mod = await import('./SessionChat')
  return mod.loadViewMode()
}

describe('view mode default', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  // The bug the user hit: a fresh profile opened every agent pane on the raw
  // terminal, so chat only appeared after they had already typed a message.
  it('is chat when nothing is stored', async () => {
    await expect(loadViewMode()).resolves.toBe('chat')
  })

  it('honours an explicit terminal preference', async () => {
    window.localStorage.setItem('orchestra.viewMode', 'terminal')
    await expect(loadViewMode()).resolves.toBe('terminal')
  })

  it('treats a junk value as chat', async () => {
    window.localStorage.setItem('orchestra.viewMode', 'wat')
    await expect(loadViewMode()).resolves.toBe('chat')
  })
})

describe('chat availability', () => {
  // TerminalInstance gates the chat overlay on this alone now — it used to also
  // require the transcript to be paired, which no new session can satisfy.
  it('covers every agent pane from its first frame', () => {
    expect(isAgentSession('claude')).toBe(true)
    expect(isAgentSession('codex')).toBe(true)
  })

  it('still withholds chat from shell panes', () => {
    expect(isAgentSession('shell')).toBe(false)
    expect(isAgentSession(undefined)).toBe(false)
  })
})

describe('chat availability during launch', () => {
  // The remaining flash: process-monitor polls `ps` once a second and can only
  // see the agent after the PTY's shell has exec'd it, so a session the user
  // just launched as Claude reads as 'terminal' for a poll or two. Gating on
  // that alone painted the raw grid first and swapped to chat a second later.
  it('treats a session launched as an agent as an agent pane', () => {
    expect(isChatAvailable('terminal', { agent: 'claude', confirmed: false })).toBe(true)
    expect(isChatAvailable(undefined, { agent: 'codex', confirmed: false })).toBe(true)
  })

  it('keeps chat once the launch is confirmed and the status catches up', () => {
    expect(isChatAvailable('claude', { agent: 'claude', confirmed: true })).toBe(true)
  })

  // useProcessStatus drops the launch record when the live session list says no
  // agent came up — that is the moment the pane is allowed to fall back.
  it('falls back to the terminal when the launch is dropped', () => {
    expect(isChatAvailable('terminal', undefined)).toBe(false)
  })

  it('never offers chat to a shell pane', () => {
    expect(isChatAvailable('terminal')).toBe(false)
    expect(isChatAvailable(undefined)).toBe(false)
  })

  // Cursor's agent has no transcript we can read, so it stays terminal-only even
  // though the store records its launch like any other agent's.
  it('withholds chat from a cursor launch', () => {
    expect(isChatAvailable('cursor', { agent: 'cursor', confirmed: true })).toBe(false)
  })
})
