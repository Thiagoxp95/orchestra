// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, CreateTerminalOpts, ProcessStatus } from '../shared/types'

const api: ElectronAPI = {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => {
    ipcRenderer.send('terminal-create', sessionId, opts)
  },
  killTerminal: (sessionId: string) => {
    ipcRenderer.send('terminal-kill', sessionId)
  },
  resizeTerminal: (sessionId: string, cols: number, rows: number) => {
    ipcRenderer.send('terminal-resize', sessionId, cols, rows)
  },
  writeTerminal: (sessionId: string, data: string) => {
    ipcRenderer.send('terminal-write', sessionId, data)
  },
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    const handler = (_event: any, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('terminal-data', handler)
    return () => { ipcRenderer.removeListener('terminal-data', handler) }
  },
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus) => void) => {
    ipcRenderer.on('process-change', (_event, sessionId, status) => callback(sessionId, status))
  },
  onTerminalExit: (callback: (sessionId: string) => void) => {
    ipcRenderer.on('terminal-exit', (_event, sessionId) => callback(sessionId))
  },
  onTerminalSnapshot: (callback: (sessionId: string, snapshot: any) => void) => {
    const handler = (_event: any, sessionId: string, snapshot: any) => callback(sessionId, snapshot)
    ipcRenderer.on('terminal-snapshot', handler)
    return () => { ipcRenderer.removeListener('terminal-snapshot', handler) }
  },
  captureScrollback: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-capture-scrollback', sessionId)
  },
  getCwd: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-get-cwd', sessionId)
  },
  getPersistedData: () => {
    return ipcRenderer.invoke('get-persisted-data')
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('terminal-data')
    ipcRenderer.removeAllListeners('process-change')
    ipcRenderer.removeAllListeners('terminal-exit')
    ipcRenderer.removeAllListeners('terminal-snapshot')
  },
  selectDirectory: () => {
    return ipcRenderer.invoke('select-directory')
  },
  saveState: (data) => {
    ipcRenderer.send('save-state', data)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
