import { beforeEach, describe, expect, it, vi } from 'vitest'

const dockBounce = vi.fn()
const notificationShow = vi.fn()
const remoteBridgeNotify = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true, dock: { bounce: dockBounce, cancelBounce: vi.fn() } },
  BrowserWindow: vi.fn(),
  Notification: class {
    static isSupported(): boolean { return true }
    on(): void {}
    show(): void { notificationShow() }
  },
}))

vi.mock('./remote-bridge-notify', () => ({ remoteBridgeNotify, noteRemoteBridgeWorking: vi.fn() }))

const { initIdleNotifier, notifyIdleTransition, notifyTerminalAttention, setOnRequiresUserInput } = await import('./idle-notifier')
const { noteSessionOrigins } = await import('./session-origin')

const send = vi.fn()
const onRequiresUserInput = vi.fn()

describe('notifications for agent (MCP) sessions', () => {
  beforeEach(() => {
    for (const fn of [dockBounce, notificationShow, remoteBridgeNotify, send, onRequiresUserInput]) fn.mockClear()
    // The user is away from the Mac: every alert path is armed.
    initIdleNotifier({ isDestroyed: () => false, isFocused: () => false, on: vi.fn(), webContents: { send } } as any)
    setOnRequiresUserInput(onRequiresUserInput)
    noteSessionOrigins({ mine: {}, bot: { origin: 'mcp' } })
  })

  it('keeps the state but sends no toast, sound, bounce, native notification or push when an agent session finishes', async () => {
    await notifyIdleTransition('bot', 'claude', undefined, undefined, false, false)

    expect(send).toHaveBeenCalledWith('idle-notification', expect.objectContaining({ sessionId: 'bot', showToast: false }))
    expect(dockBounce).not.toHaveBeenCalled()
    expect(notificationShow).not.toHaveBeenCalled()
    expect(remoteBridgeNotify).not.toHaveBeenCalled()
  })

  it('stays silent when an agent session needs input', () => {
    notifyTerminalAttention('bot', 'claude', 'Approve?')

    expect(send).toHaveBeenCalledWith('idle-notification', expect.objectContaining({ sessionId: 'bot', requiresUserInput: true, showToast: false }))
    expect(onRequiresUserInput).not.toHaveBeenCalled()
    expect(dockBounce).not.toHaveBeenCalled()
    expect(notificationShow).not.toHaveBeenCalled()
    expect(remoteBridgeNotify).not.toHaveBeenCalled()
  })

  it("still alerts for the user's own sessions", async () => {
    await notifyIdleTransition('mine', 'claude', undefined, undefined, false, false)
    expect(send).toHaveBeenCalledWith('idle-notification', expect.objectContaining({ sessionId: 'mine', showToast: true }))
    expect(dockBounce).toHaveBeenCalled()
    expect(notificationShow).toHaveBeenCalled()
    expect(remoteBridgeNotify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mine' }))

    notifyTerminalAttention('mine', 'claude', 'Approve?')
    expect(onRequiresUserInput).toHaveBeenCalledWith('mine', 'claude')
  })
})
