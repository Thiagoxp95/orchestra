import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const appMock = {
  isPackaged: false,
  getPath: vi.fn(() => '/tmp/orchestra-test'),
  getVersion: vi.fn(() => '1.0.0'),
}

vi.mock('electron', () => ({
  app: appMock,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

describe('initUpdater', () => {
  beforeEach(() => {
    handlers.clear()
    appMock.isPackaged = false
    vi.clearAllMocks()
  })

  it('registers update IPC handlers in development builds', async () => {
    const { initUpdater } = await import('./updater')

    initUpdater({
      webContents: {
        send: vi.fn(),
        once: vi.fn(),
      },
    } as any)

    expect(handlers.has('get-update-status')).toBe(true)
    expect(handlers.get('get-update-status')?.()).toBeNull()
  })
})
