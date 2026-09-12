// SerializeAddon contains cells and modes, but deliberately omits an unfinished
// parser command. Retain its exact prefix, without replaying C0 controls that
// already executed inside CSI/ESC. DCS/SOS/PM/APC cuts are explicitly unsupported.
export class ParserContinuation {
  private state: 'ground' | 'escape' | 'csi' | 'osc' | 'string' | 'stringEscape' = 'ground'
  private prefix = ''
  private overflow = false
  private static readonly LIMIT = 64 * 1024

  feed(data: string, complete: (sequence: string) => void): void {
    for (const ch of data) {
      const code = ch.codePointAt(0)!
      if (code === 0x18 || code === 0x1a) { this.reset(); continue }
      if (this.state === 'string' || this.state === 'stringEscape') {
        if (code === 0x9c || (this.state === 'stringEscape' && ch === '\\')) this.reset()
        else this.state = ch === '\x1b' ? 'stringEscape' : 'string'
        continue
      }
      if (ch === '\x1b') {
        // OSC dispatches when ESC arrives; the ESC starts the next command.
        if (this.state === 'osc' && !this.overflow) complete(this.prefix + '\x1b\\')
        this.reset('escape', ch)
        continue
      }
      if (code === 0x9b) { this.reset('csi', '\x1b['); continue }
      if (code === 0x9d) { this.reset('osc', '\x1b]'); continue }
      if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) { this.reset('string'); continue }
      if (this.state === 'ground') continue
      if (this.state === 'osc') {
        if (ch === '\x07' || code === 0x9c) {
          if (!this.overflow) complete(this.prefix + '\x07')
          this.reset()
        } else this.add(ch)
        continue
      }
      // These controls execute independently while leaving ESC/CSI pending.
      if (code < 0x20 || code === 0x7f) continue
      if (this.state === 'escape') {
        if (this.prefix === '\x1b' && ch === '[') { this.add(ch); this.state = 'csi' }
        else if (this.prefix === '\x1b' && ch === ']') { this.add(ch); this.state = 'osc' }
        else if (this.prefix === '\x1b' && ['P', 'X', '^', '_'].includes(ch)) this.reset('string')
        else if (code >= 0x30 && code <= 0x7e) {
          if (!this.overflow) complete(this.prefix + ch)
          this.reset()
        } else this.add(ch)
      } else {
        this.add(ch)
        if (code >= 0x40 && code <= 0x7e) {
          if (!this.overflow) complete(this.prefix)
          this.reset()
        }
      }
    }
  }

  assertParserState(actual: number): void {
    const expected: number[] = { ground: [0], escape: [1, 2], csi: [3, 4, 5, 6], osc: [8], string: [], stringEscape: [] }[this.state]
    if (!expected.includes(actual)) throw new Error('Unsupported terminal checkpoint: parser state')
  }

  get suffix(): string {
    if (this.overflow || this.state === 'string' || this.state === 'stringEscape') {
      throw new Error('Unsupported terminal checkpoint: incomplete control string')
    }
    return this.prefix
  }

  private add(ch: string): void {
    if (this.prefix.length + ch.length > ParserContinuation.LIMIT) this.overflow = true
    if (!this.overflow) this.prefix += ch
  }

  private reset(state: typeof this.state = 'ground', prefix = ''): void {
    this.state = state
    this.prefix = prefix
    this.overflow = false
  }
}
