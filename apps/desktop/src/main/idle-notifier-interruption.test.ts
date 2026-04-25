import { beforeEach, describe, expect, it, vi } from 'vitest'

const dockBounce = vi.fn()
const dockCancelBounce = vi.fn()
const notificationShow = vi.fn()

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
    on(): void {}
    show(): void { notificationShow() }
  },
}))

describe('notifyIdleTransition interruptions', () => {
  beforeEach(() => {
    vi.resetModules()
    dockBounce.mockClear()
    dockCancelBounce.mockClear()
    notificationShow.mockClear()
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
})
