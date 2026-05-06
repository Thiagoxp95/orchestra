import { beforeEach, describe, expect, it, vi } from 'vitest'

const dockBounce = vi.fn()
const dockCancelBounce = vi.fn()
const notificationShow = vi.fn()
const notificationConstructed = vi.fn()

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    dock: {
      bounce: dockBounce,
      cancelBounce: dockCancelBounce,
    },
  },
  BrowserWindow: vi.fn(),
  Notification: class {
    static isSupported(): boolean { return true }
    constructor(options: { title: string; body: string; silent: boolean }) {
      notificationConstructed(options)
    }
    on(): void {}
    show(): void { notificationShow() }
  },
}))

describe('notifyIdleTransition interruptions', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('./terminal-output-buffer')
    dockBounce.mockClear()
    dockCancelBounce.mockClear()
    notificationShow.mockClear()
    notificationConstructed.mockClear()
  })

  it('does not send toast, dock, or native notifications for interrupted runs', async () => {
    const { initIdleNotifier, notifyIdleTransition } = await import('./idle-notifier')
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      on: vi.fn(),
      webContents: { send },
    }

    initIdleNotifier(window as any)
    await notifyIdleTransition('session-1', 'codex', undefined, undefined, true)

    expect(send).not.toHaveBeenCalledWith('idle-notification', expect.anything())
    expect(dockBounce).not.toHaveBeenCalled()
    expect(notificationShow).not.toHaveBeenCalled()
  })

  it('marks Claude idle transitions as needing input when the last response asks a question', async () => {
    vi.doMock('./terminal-output-buffer', () => ({
      getAgentResponseText: vi.fn(() => 'What are you working on right now?'),
      getLastMeaningfulText: vi.fn(() => ''),
      getTerminalBufferText: vi.fn(() => ''),
      markWorkingStart: vi.fn(),
    }))

    const { initIdleNotifier, notifyIdleTransition } = await import('./idle-notifier')
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => true),
      on: vi.fn(),
      webContents: { send },
    }

    initIdleNotifier(window as any)
    await notifyIdleTransition('session-1', 'claude')

    expect(send).toHaveBeenCalledWith('idle-notification', expect.objectContaining({
      sessionId: 'session-1',
      agentType: 'claude',
      requiresUserInput: true,
    }))
  })

  it('uses the session title for native finished notifications instead of a generic agent heading', async () => {
    const { initIdleNotifier, notifyIdleTransition, setSessionNotificationTitle } = await import('./idle-notifier')
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      on: vi.fn(),
      webContents: { send },
    }

    initIdleNotifier(window as any)
    setSessionNotificationTitle('session-1', "We've been trying to fix this for so long")
    await notifyIdleTransition('session-1', 'codex')

    expect(notificationConstructed).toHaveBeenCalledWith(expect.objectContaining({
      title: "We've been trying to fix this for so long finished",
    }))
    expect(notificationConstructed).not.toHaveBeenCalledWith(expect.objectContaining({
      title: 'Codex is ready',
    }))
  })
})
