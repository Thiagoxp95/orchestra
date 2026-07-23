/// <reference types="vite/client" />

import type { ElectronAPI } from '../../shared/types'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
  /** Packaged app version, baked in at build time (see electron.vite.config.ts). */
  const __APP_VERSION__: string
}
