// src/daemon/headless-emulator.ts
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { SessionSnapshot } from './protocol'
import { checkpointState } from './checkpoint-state'
import { ParserContinuation } from './parser-continuation'
import { STREAM_CHECKPOINT_BYTES } from './terminal-stream'
import { geometryPayload } from '../shared/terminal-stream/protocol'

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

  // All parser writes, geometry changes and snapshot cuts share this queue.
  private queue: Promise<unknown> = Promise.resolve()
  private continuation = new ParserContinuation()

  constructor(cols: number, rows: number, cwd: string) {
    this.terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true })
    this.serializeAddon = new SerializeAddon()
    this.terminal.loadAddon(this.serializeAddon)
    this.cwd = cwd
  }

  setHasClients(_has: boolean): void {}

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Terminal disposed'))
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  write(data: string): void {
    if (this.disposed) return
    void this.enqueue(() => new Promise<void>(resolve => {
      this.terminal.write(data, () => {
        this.continuation.feed(data, sequence => this.parseEscapeSequences(sequence))
        resolve()
      })
    }))
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    void this.enqueue(() => this.terminal.resize(cols, rows))
  }

  getSnapshot(): SessionSnapshot {
    const snapshotAnsi = this.serializeAddon.serialize({
      scrollback: this.terminal.options.scrollback ?? 10_000
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

  getSnapshotAsync(): Promise<SessionSnapshot> {
    return this.enqueue(() => this.getSnapshot())
  }

  getStreamSnapshotAsync(): Promise<{ data: string; cols: number; rows: number }> {
    // Reserve before returning the Promise. Later operations cannot enter this cut.
    return this.enqueue(() => {
      geometryPayload(this.terminal.cols, this.terminal.rows)
      const continuation = this.continuation.suffix
      const parserState = (this.terminal as unknown as { _core: { _inputHandler: { _parser: { currentState: number } } } })._core._inputHandler._parser.currentState
      this.continuation.assertParserState(parserState)
      const data = this.serializeAddon.serialize({ scrollback: 10_000, excludeModes: true })
        + checkpointState(this.terminal) + continuation
      if (Buffer.byteLength(JSON.stringify({ data, cols: this.terminal.cols, rows: this.terminal.rows }), 'utf8') + 256 > STREAM_CHECKPOINT_BYTES) {
        throw new Error('Unsupported terminal checkpoint: snapshot exceeds byte limit')
      }
      return { data, cols: this.terminal.cols, rows: this.terminal.rows }
    })
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
    void this.queue.then(() => this.terminal.dispose())
  }

  // Parse DECSET/DECRST mode changes and OSC-7 CWD
  private parseEscapeSequences(data: string): void {
    if (data === '\x1bc') this.modes = { ...DEFAULT_MODES }
    // DECSET: ESC[?Nh  DECRST: ESC[?Nl
    const modeRegex = /\x1b\[\?([\d;]+)([hl])/g
    let match: RegExpExecArray | null
    while ((match = modeRegex.exec(data)) !== null) {
      const set = match[2] === 'h'
      for (const mode of match[1].split(';')) {
        const key = MODE_MAP[Number(mode)]
        if (key) this.modes[key] = set
      }
    }

    // OSC-7: ESC]7;file://hostname/path BEL or ST
    const osc7Regex = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
    while ((match = osc7Regex.exec(data)) !== null) {
      try {
        const path = decodeURIComponent(match[1])
        if (path) this.cwd = path
      } catch { /* A malformed OSC path must not stall the parser queue. */ }
    }
  }

  private generateRehydrateSequences(): string {
    let seq = ''
    // Only emit non-default modes
    for (const [code, key] of Object.entries(MODE_MAP)) {
      if (key !== 'alternateScreen' && key !== 'originMode' && this.modes[key] !== DEFAULT_MODES[key]) {
        seq += `\x1b[?${code}${this.modes[key] ? 'h' : 'l'}`
      }
    }
    return seq
  }
}
