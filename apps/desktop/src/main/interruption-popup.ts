import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { InterruptionPosition } from '../shared/types'

const POPUP_WIDTH = 800
const POPUP_HEIGHT = 400
const MARGIN = 16
const STACK_OFFSET = 30

interface PopupMeta {
  window: BrowserWindow
  sessionId: string
  workspaceId: string
}

const activePopups = new Map<string, PopupMeta>()

function getPopupPosition(
  position: InterruptionPosition | undefined,
  stackIndex: number,
): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  const pos = position ?? 'bottom-right'

  let x: number
  let y: number

  if (typeof pos === 'object') {
    x = pos.x
    y = pos.y
  } else if (pos === 'bottom-left') {
    x = workArea.x + MARGIN
    y = workArea.y + workArea.height - POPUP_HEIGHT - MARGIN
  } else {
    // bottom-right (default)
    x = workArea.x + workArea.width - POPUP_WIDTH - MARGIN
    y = workArea.y + workArea.height - POPUP_HEIGHT - MARGIN
  }

  // Stack offset for multiple popups
  x += stackIndex * STACK_OFFSET
  y -= stackIndex * STACK_OFFSET

  return { x, y }
}

export function showInterruptionPopup(
  sessionId: string,
  workspaceId: string,
  workspaceName: string,
  workspaceColor: string,
  sessionLabel: string,
  position: InterruptionPosition | undefined,
): void {
  // Don't create a duplicate popup for the same session
  if (activePopups.has(sessionId)) {
    const existing = activePopups.get(sessionId)!
    if (!existing.window.isDestroyed()) {
      existing.window.focus()
      return
    }
    activePopups.delete(sessionId)
  }

  const stackIndex = activePopups.size
  const { x, y } = getPopupPosition(position, stackIndex)

  const popup = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Pass session info via URL query params
  const params = new URLSearchParams({
    sessionId,
    workspaceId,
    workspaceName,
    workspaceColor,
    sessionLabel,
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    popup.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/popup.html?${params}`)
  } else {
    popup.loadFile(join(__dirname, '../renderer/popup.html'), {
      search: params.toString(),
    })
  }

  popup.once('ready-to-show', () => {
    popup.show()
    popup.focus()
  })

  popup.on('closed', () => {
    activePopups.delete(sessionId)
  })

  activePopups.set(sessionId, { window: popup, sessionId, workspaceId })
}

export function closeInterruptionPopup(sessionId: string): void {
  const meta = activePopups.get(sessionId)
  if (!meta) return
  if (!meta.window.isDestroyed()) {
    meta.window.close()
  }
  activePopups.delete(sessionId)
}

export function closeAllInterruptionPopups(workspaceId?: string): void {
  for (const [sessionId, meta] of activePopups) {
    if (workspaceId && meta.workspaceId !== workspaceId) continue
    if (!meta.window.isDestroyed()) {
      meta.window.close()
    }
    activePopups.delete(sessionId)
  }
}

export function hasActivePopup(sessionId: string): boolean {
  const meta = activePopups.get(sessionId)
  return !!meta && !meta.window.isDestroyed()
}

/**
 * Forward an IPC event to the popup window for a given session.
 * Used by daemon-client to relay terminal-data and terminal-snapshot
 * events that are normally only sent to the main window.
 */
export function forwardToPopup(sessionId: string, channel: string, ...args: any[]): void {
  const meta = activePopups.get(sessionId)
  if (!meta || meta.window.isDestroyed()) return
  meta.window.webContents.send(channel, ...args)
}
