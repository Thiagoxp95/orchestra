// src/daemon/headless-emulator.ts
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { SessionSnapshot } from './protocol'

export interface TerminalModes {
  applicationCursorKeys: boolean
  originMode: boolean
  autoWrap: boolean
  cursorVisible: boolean
  bracketedPaste: boolean
  mouseTracking: boolean
  mouseSgr: boolean
  focusReporting: boolean
  alternateScreen: boolean
}

const DEFAULT_MODES: TerminalModes = {
  applicationCursorKeys: false,
  originMode: false,
  autoWrap: true,
  cursorVisible: true,
  bracketedPaste: false,
  mouseTracking: false,
  mouseSgr: false,
  focusReporting: false,
  alternateScreen: false
}

const MODE_MAP: Record<number, keyof TerminalModes> = {
  1: 'applicationCursorKeys',
  6: 'originMode',
  7: 'autoWrap',
  25: 'cursorVisible',
  1000: 'mouseTracking',
  1002: 'mouseTracking',
  1003: 'mouseTracking',
  1006: 'mouseSgr',
  1004: 'focusReporting',
  2004: 'bracketedPaste',
  47: 'alternateScreen',
  1049: 'alternateScreen'
}

export class HeadlessEmulator {
  private terminal: Terminal
  private serializeAddon: SerializeAddon
  private modes: TerminalModes = { ...DEFAULT_MODES }
  private cwd: string = ''
  private disposed = false

  // Write queue for async batched processing
  private writeQueue: string[] = []
  private writeScheduled = false
  private hasClients = false

  constructor(cols: number, rows: number, cwd: string) {
    this.terminal = new Terminal({ cols, rows, scrollback: 2000 })
    this.serializeAddon = new SerializeAddon()
    this.terminal.loadAddon(this.serializeAddon)
    this.cwd = cwd
  }

  setHasClients(has: boolean): void {
    this.hasClients = has
  }

  write(data: string): void {
    this.writeQueue.push(data)
    this.parseEscapeSequences(data)
    if (!this.writeScheduled) {
      this.writeScheduled = true
      setImmediate(() => this.processWriteQueue())
    }
  }

  private processWriteQueue(): void {
    this.writeScheduled = false
    if (this.disposed) return

    const timeBudget = this.hasClients ? 5 : 25
    const start = performance.now()

    while (this.writeQueue.length > 0) {
      const chunk = this.writeQueue.shift()!
      this.terminal.write(chunk)
      if (performance.now() - start > timeBudget) {
        // Reschedule remaining
        if (this.writeQueue.length > 0 && !this.writeScheduled) {
          this.writeScheduled = true
          setImmediate(() => this.processWriteQueue())
        }
        return
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.terminal.resize(cols, rows)
  }

  getSnapshot(): SessionSnapshot {
    const snapshotAnsi = this.serializeAddon.serialize({
      scrollback: this.terminal.options.scrollback ?? 2000
    })
    const rehydrateSequences = this.generateRehydrateSequences()
    return {
      snapshotAnsi,
      rehydrateSequences,
      cwd: this.cwd,
      cols: this.terminal.cols,
      rows: this.terminal.rows
    }
  }

  async getSnapshotAsync(): Promise<SessionSnapshot> {
    // Flush pending writes
    await new Promise<void>((resolve) => {
      this.terminal.write('', () => resolve())
    })
    return this.getSnapshot()
  }

  getCwd(): string {
    return this.cwd
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.terminal.dispose()
  }

  // Parse DECSET/DECRST mode changes and OSC-7 CWD
  private parseEscapeSequences(data: string): void {
    // DECSET: ESC[?Nh  DECRST: ESC[?Nl
    const modeRegex = /\x1b\[\?(\d+)([hl])/g
    let match: RegExpExecArray | null
    while ((match = modeRegex.exec(data)) !== null) {
      const mode = parseInt(match[1], 10)
      const set = match[2] === 'h'
      const key = MODE_MAP[mode]
      if (key) {
        this.modes[key] = set
      }
    }

    // OSC-7: ESC]7;file://hostname/path BEL or ST
    const osc7Regex = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
    while ((match = osc7Regex.exec(data)) !== null) {
      const path = decodeURIComponent(match[1])
      if (path) this.cwd = path
    }
  }

  private generateRehydrateSequences(): string {
    let seq = ''
    // Only emit non-default modes
    for (const [code, key] of Object.entries(MODE_MAP)) {
      if (this.modes[key] !== DEFAULT_MODES[key]) {
        seq += `\x1b[?${code}${this.modes[key] ? 'h' : 'l'}`
      }
    }
    return seq
  }
}
