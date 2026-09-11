import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/** GPU acceleration is optional; xterm's DOM renderer remains usable after context loss. */
export function enableTerminalWebgl(terminal: Terminal): void {
  let addon: WebglAddon | undefined
  try {
    addon = new WebglAddon()
    addon.onContextLoss(() => { try { addon?.dispose() } catch {} })
    terminal.loadAddon(addon)
  } catch { try { addon?.dispose() } catch {} }
}
