import { extendedAttributes } from './checkpoint-attributes'
import { Terminal, type IBuffer, type IBufferCell } from '@xterm/headless'

// xterm 6's public serializer does not include margins, tab stops, saved cursor
// or charset state. Keep this narrow compatibility boundary covered by replay
// tests. If xterm changes its internal contract, fail the checkpoint explicitly.
type Charset = Record<string, string> | undefined
interface Attributes extends Pick<IBufferCell, 'isBold' | 'isDim' | 'isItalic' | 'isUnderline' | 'isBlink' | 'isInverse' | 'isInvisible' | 'isStrikethrough' | 'isOverline' | 'isFgRGB' | 'isFgPalette' | 'getFgColor' | 'isBgRGB' | 'isBgPalette' | 'getBgColor'> {
  isProtected?(): number
  hasExtendedAttrs?(): number
  getUnderlineStyle?(): number
  extended?: { underlineColor: number; urlId: number; underlineVariantOffset: number }
}
interface InternalBuffer {
  x: number; y: number; ybase: number
  scrollTop: number; scrollBottom: number
  savedX: number; savedY: number; savedCurAttrData: Attributes; savedCharset: Charset
  tabs: Record<number, boolean>
}
interface TerminalCore {
  _bufferService: { buffers: { normal: InternalBuffer; alt: InternalBuffer } }
  _charsetService: { charset: Charset; glevel: number; _charsets: Charset[] }
  _inputHandler: { _curAttrData: Attributes; selectCharset(value: string): void }
  coreService: { isCursorHidden: boolean }
  coreMouseService: { activeEncoding: string }
}
function core(terminal: Terminal): TerminalCore {
  const value = (terminal as unknown as { _core: TerminalCore })._core
  if (!value?._bufferService?.buffers?.normal?.savedCurAttrData || !value._charsetService?._charsets || !value._inputHandler?._curAttrData) {
    throw new Error('Unsupported terminal checkpoint: xterm state contract changed')
  }
  return value
}

let charsetNames: Map<Charset, string> | undefined
function charsetName(charset: Charset): string {
  if (!charset) return 'B'
  if (!charsetNames) {
    charsetNames = new Map()
    const probe = new Terminal()
    try {
      const state = core(probe)
      for (const name of ['0', 'A', 'B', '4', 'C', 'R', 'Q', 'K', 'Y', 'E', 'Z', 'H', '=']) {
        state._inputHandler.selectCharset('(' + name)
        charsetNames.set(state._charsetService.charset, name)
      }
    } finally { probe.dispose() }
  }
  const name = charsetNames.get(charset)
  if (!name) throw new Error('Unsupported terminal checkpoint: unknown charset')
  return name
}

function attributes(value: Attributes, terminal: Terminal): string {
  const codes = [0]
  const flags: [keyof Pick<Attributes, 'isBold' | 'isDim' | 'isItalic' | 'isUnderline' | 'isBlink' | 'isInverse' | 'isInvisible' | 'isStrikethrough' | 'isOverline'>, number][] = [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9], ['isOverline', 53]]
  for (const [key, code] of flags) if (value[key]?.call(value)) codes.push(code)
  for (const fg of [true, false]) {
    const rgb = fg ? value.isFgRGB() : value.isBgRGB()
    const palette = fg ? value.isFgPalette() : value.isBgPalette()
    const color = fg ? value.getFgColor() : value.getBgColor()
    if (rgb) codes.push(fg ? 38 : 48, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255)
    else if (palette) codes.push(fg ? 38 : 48, 5, color)
  }
  return `\x1b[${codes.join(';')}m\x1b[${value.isProtected?.() ? 1 : 0}"q` + extendedAttributes(value, terminal)
}

function position(x: number, y: number, originTop = 0): string {
  return `\x1b[${y - originTop + 1};${x + 1}H`
}

function bufferState(buffer: InternalBuffer, cols: number, rows: number, terminal: Terminal): string {
  let data = '\x1b[?6l\x1b(B\x0f'
  data += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`
  // Save the effective restore position. Positions above retained history always
  // restore at row zero in xterm, and cannot reappear after subsequent scrolling.
  const savedY = Math.max(0, Math.min(rows - 1, buffer.savedY - buffer.ybase))
  data += position(Math.min(cols - 1, buffer.savedX), savedY)
  data += attributes(buffer.savedCurAttrData, terminal) + `\x1b(${charsetName(buffer.savedCharset)}\x1b7\x1b(B`
  data += '\x1b[3g'
  for (let col = 0; col < cols; col++) if (buffer.tabs[col]) data += `\x1b[${col + 1}G\x1bH`
  return data
}

/** Restore non-cell state after SerializeAddon.serialize({ excludeModes: true }). */
export function checkpointState(terminal: Terminal): string {
  const state = core(terminal)
  if (state._charsetService.charset !== state._charsetService._charsets[state._charsetService.glevel]) {
    throw new Error('Unsupported terminal checkpoint: independently restored charset')
  }
  const buffers = state._bufferService.buffers
  const alternate = terminal.buffer.active.type === 'alternate'
  let data = alternate ? '\x1b[?47l' : ''
  data += bufferState(buffers.normal, terminal.cols, terminal.rows, terminal)
  // Preserve the normal cursor when an alternate screen is active.
  data += restorePosition(buffers.normal, terminal.buffer.normal, terminal.cols, terminal)
  if (alternate) {
    data += '\x1b[?47h'
    data += bufferState(buffers.alt, terminal.cols, terminal.rows, terminal)
  }
  const active = alternate ? buffers.alt : buffers.normal
  const modes = terminal.modes
  const decModes: [number, boolean][] = [
    [1, modes.applicationCursorKeysMode], [66, modes.applicationKeypadMode], [2004, modes.bracketedPasteMode],
    [6, modes.originMode], [45, modes.reverseWraparoundMode], [1004, modes.sendFocusMode],
    [7, modes.wraparoundMode], [25, !state.coreService.isCursorHidden],
  ]
  for (const [code, enabled] of decModes) data += `\x1b[?${code}${enabled ? 'h' : 'l'}`
  data += `\x1b[4${modes.insertMode ? 'h' : 'l'}`
  const tracking = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[modes.mouseTrackingMode]
  if (tracking) data += `\x1b[?${tracking}h`
  if (state.coreMouseService.activeEncoding === 'SGR') data += '\x1b[?1006h'
  else if (state.coreMouseService.activeEncoding !== 'DEFAULT') throw new Error('Unsupported terminal checkpoint: mouse encoding')
  data += restorePosition(active, terminal.buffer.active, terminal.cols, terminal, modes.originMode ? active.scrollTop : 0)
  data += attributes(state._inputHandler._curAttrData, terminal)
  for (let level = 0; level < 4; level++) data += `\x1b${'()*+'[level]}${charsetName(state._charsetService._charsets[level])}`
  // LS2/LS3 and SI/SO select the G-level. RestoreCursor can select a charset
  // independently of that level, so designate the effective charset last.
  data += ['\x0f', '\x0e', '\x1bn', '\x1bo'][state._charsetService.glevel]
  data += `\x1b${'()*+'[state._charsetService.glevel]}${charsetName(state._charsetService.charset)}`
  return data
}

function restorePosition(buffer: InternalBuffer, visible: IBuffer, cols: number, terminal: Terminal, originTop = 0): string {
  if (buffer.x < cols) return position(buffer.x, buffer.y, originTop)
  // CUP cannot express pending autowrap (x === cols). Repaint the existing final
  // cell in place so the next character wraps exactly as on the source terminal.
  const line = visible.getLine(visible.baseY + buffer.y)!
  let column = cols - 1
  while (column > 0 && line.getCell(column)!.getWidth() === 0) column--
  const cell = line.getCell(column)!
  if (!cell.getChars()) throw new Error('Unsupported terminal checkpoint: pending wrap without a cell')
  return position(column, buffer.y, originTop) + attributes(cell, terminal) + cell.getChars()
}
