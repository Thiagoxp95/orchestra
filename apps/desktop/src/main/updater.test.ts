import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoUpdater } from 'electron-updater'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  },
}))

describe('initUpdater', () => {
  beforeEach(async () => {
    handlers.clear()
    appMock.isPackaged = false
    vi.clearAllMocks()
    const { resetUpdaterState } = await import('./updater')
    resetUpdaterState()
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

  it('does not invoke electron-updater when packaged updater metadata is missing', async () => {
    const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', {
      value: '/tmp/orchestra-test-missing-resources',
      configurable: true,
    })
    appMock.isPackaged = true

    try {
      const { initUpdater } = await import('./updater')

      initUpdater({
        webContents: {
          send: vi.fn(),
          once: vi.fn(),
        },
      } as any)

      expect(handlers.get('check-for-update')?.()).toBeNull()
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      if (previousResourcesPath) {
        Object.defineProperty(process, 'resourcesPath', previousResourcesPath)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
    }
  })
})

// The remote "Restart & update" path (a restartToUpdate command from the phone).
describe('requestRestartToUpdate', () => {
  let previousResourcesPath: PropertyDescriptor | undefined

  /** A packaged install whose app-update.yml exists, so canUseUpdater() is true. */
  function bootPackagedUpdater(): Map<string, (info?: unknown) => void> {
    const resources = mkdtempSync(join(tmpdir(), 'orchestra-updater-'))
    writeFileSync(join(resources, 'app-update.yml'), 'provider: github\n')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    appMock.isPackaged = true

    const events = new Map<string, (info?: unknown) => void>()
    vi.mocked(autoUpdater.on).mockImplementation(((name: string, fn: (info?: unknown) => void) => {
      events.set(name, fn)
      return autoUpdater
    }) as never)
    return events
  }

  beforeEach(async () => {
    handlers.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    const { resetUpdaterState } = await import('./updater')
    resetUpdaterState()
  })

  afterEach(async () => {
    const { stopUpdater } = await import('./updater')
    stopUpdater()
    vi.useRealTimers()
    appMock.isPackaged = false
    if (previousResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', previousResourcesPath)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
  })

  const win = () => ({ webContents: { send: vi.fn(), once: vi.fn() } }) as never

  it('does nothing in a build with no update channel', async () => {
    appMock.isPackaged = false
    const { initUpdater, requestRestartToUpdate } = await import('./updater')
    initUpdater(win())

    expect(requestRestartToUpdate()).toEqual({ action: 'none', reason: 'unsupported' })
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('checks for updates instead of restarting when nothing is staged', async () => {
    bootPackagedUpdater()
    const { initUpdater, requestRestartToUpdate } = await import('./updater')
    initUpdater(win())

    expect(requestRestartToUpdate()).toEqual({ action: 'check', reason: 'not-downloaded' })
    vi.advanceTimersByTime(5000)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
  })

  it('installs a staged update, but only after the ack grace window', async () => {
    const events = bootPackagedUpdater()
    const { initUpdater, requestRestartToUpdate } = await import('./updater')
    initUpdater(win())
    events.get('update-downloaded')?.({ version: '1.21.48' })

    expect(requestRestartToUpdate()).toEqual({ action: 'install', version: '1.21.48' })
    // The command's ack must reach Convex before the process dies, or the row is
    // still pending when the freshly installed app comes back up.
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a repeated command never restarts twice', async () => {
    // Two taps on the phone are two DISTINCT command rows, so the drain's
    // per-id dedup cannot catch this — the latch here is what does.
    const events = bootPackagedUpdater()
    const { initUpdater, requestRestartToUpdate } = await import('./updater')
    initUpdater(win())
    events.get('update-downloaded')?.({ version: '1.21.48' })

    expect(requestRestartToUpdate().action).toBe('install')
    expect(requestRestartToUpdate()).toEqual({ action: 'none', reason: 'already-restarting' })
    expect(requestRestartToUpdate()).toEqual({ action: 'none', reason: 'already-restarting' })

    vi.advanceTimersByTime(10_000)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does not restart again for a duplicate arriving after the local install button', async () => {
    const events = bootPackagedUpdater()
    const { initUpdater, requestRestartToUpdate } = await import('./updater')
    initUpdater(win())
    events.get('update-downloaded')?.({ version: '1.21.48' })

    expect(handlers.get('install-update')?.()).toBe(true)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(requestRestartToUpdate()).toEqual({ action: 'none', reason: 'already-restarting' })
    vi.advanceTimersByTime(10_000)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('still finds the staged update after a later background re-check', async () => {
    const events = bootPackagedUpdater()
    const { initUpdater, requestRestartToUpdate, getMirroredUpdate } = await import('./updater')
    initUpdater(win())
    events.get('update-downloaded')?.({ version: '1.21.48' })
    // The 30-minute poll runs while the artifact sits on disk.
    events.get('checking-for-update')?.()
    events.get('update-not-available')?.()

    expect(getMirroredUpdate().updateDownloaded).toBe(true)
    expect(requestRestartToUpdate().action).toBe('install')
  })

  it('publishes the mirrored verdict, and notifies the bridge as it moves', async () => {
    const events = bootPackagedUpdater()
    const { initUpdater, getMirroredUpdate, requestRestartToUpdate, setUpdateStatusListener } =
      await import('./updater')
    initUpdater(win())
    const onChange = vi.fn()
    setUpdateStatusListener(onChange)

    expect(getMirroredUpdate()).toMatchObject({
      supported: true,
      state: 'idle',
      updateAvailable: false,
      updateDownloaded: false,
      currentVersion: '1.0.0',
      availableVersion: null,
      restartPending: false,
    })

    events.get('update-downloaded')?.({ version: '1.21.48' })
    expect(onChange).toHaveBeenCalled()
    expect(getMirroredUpdate()).toMatchObject({
      state: 'downloaded',
      updateAvailable: true,
      updateDownloaded: true,
      availableVersion: '1.21.48',
    })

    requestRestartToUpdate()
    expect(getMirroredUpdate().restartPending).toBe(true)
  })
})
