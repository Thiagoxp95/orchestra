// Matches CSI sequences (including private-mode like \x1b[?2004h) and OSC sequences (\x1b]...ST)
const ANSI_RE = /^\x1b(?:\[[?>=<]*[0-9;]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/

/**
 * Try to match `command` at the start of `buffer`, skipping ANSI escape
 * sequences that the shell may have interleaved during echo.
 *
 * Returns the number of buffer characters consumed for a full match,
 * `'partial'` if the buffer is a possible prefix, or `null` on mismatch.
 */
function matchSkippingAnsi(buffer: string, command: string): number | 'partial' | null {
  let bi = 0 // buffer index
  let ci = 0 // command index

  while (ci < command.length) {
    if (bi >= buffer.length) return 'partial'

    // Skip ANSI escape sequences in the buffer
    const ansi = buffer.slice(bi).match(ANSI_RE)
    if (ansi) {
      bi += ansi[0].length
      continue
    }

    // Might be a partial escape sequence — need more data
    if (buffer[bi] === '\x1b' && bi + 1 >= buffer.length) {
      return 'partial'
    }

    // Carriage return: if followed by \n it's a line ending (handled elsewhere);
    // otherwise the shell line editor is redrawing — restart matching from the
    // beginning of the command since the display line is being rewritten.
    if (buffer[bi] === '\r') {
      if (bi + 1 >= buffer.length) return 'partial'
      if (buffer[bi + 1] !== '\n') {
        bi++
        ci = 0
        continue
      }
    }

    if (buffer[bi] === command[ci]) {
      bi++
      ci++
    } else {
      return null
    }
  }

  // Full match — also consume any trailing ANSI sequences before the newline
  while (bi < buffer.length) {
    const ansi = buffer.slice(bi).match(ANSI_RE)
    if (ansi) {
      bi += ansi[0].length
      continue
    }
    break
  }

  return bi
}

export class HiddenInputEchoFilter {
  private pendingCommands: string[] = []
  private buffer = ''
  private swallowingLineEnding = false

  hideNextCommand(command: string): void {
    if (!command) return
    this.pendingCommands.push(command)
  }

  consume(chunk: string): string {
    this.buffer += chunk
    let output = ''

    while (this.buffer.length > 0) {
      if (this.swallowingLineEnding) {
        if (this.buffer[0] === '\r') {
          this.buffer = this.buffer.slice(1)
          continue
        }
        if (this.buffer[0] === '\n') {
          this.buffer = this.buffer.slice(1)
          this.swallowingLineEnding = false
          continue
        }
        this.swallowingLineEnding = false
      }

      const pending = this.pendingCommands[0]
      if (!pending) {
        output += this.buffer
        this.buffer = ''
        break
      }

      const result = matchSkippingAnsi(this.buffer, pending)

      if (typeof result === 'number') {
        // Full match — consume matched portion and swallow trailing newline
        this.buffer = this.buffer.slice(result)
        this.pendingCommands.shift()
        this.swallowingLineEnding = true
        continue
      }

      if (result === 'partial') {
        // Buffer might still match once more data arrives
        break
      }

      // No match at this position — pass through one character and retry
      output += this.buffer[0]
      this.buffer = this.buffer.slice(1)
    }

    return output
  }

  reset(): void {
    this.pendingCommands = []
    this.buffer = ''
    this.swallowingLineEnding = false
  }
}
