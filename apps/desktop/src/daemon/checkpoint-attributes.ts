import type { Terminal, IBufferCell } from '@xterm/headless'

interface ExtendedAttributes extends Pick<IBufferCell, 'isBold' | 'isDim' | 'isItalic' | 'isUnderline' | 'isBlink' | 'isInverse' | 'isInvisible' | 'isStrikethrough' | 'isOverline' | 'isFgRGB' | 'isFgPalette' | 'getFgColor' | 'isBgRGB' | 'isBgPalette' | 'getBgColor'> {
  hasExtendedAttrs?(): number
  getUnderlineStyle?(): number
  isProtected?(): number
  extended?: { underlineColor: number; urlId: number; underlineVariantOffset: number }
}
/** xterm 6 compatibility seam for attributes not emitted by addon-serialize. */
export function extendedAttributes(attributes: object, terminal: Terminal): string {
  const value = attributes as ExtendedAttributes
  if (value.isProtected?.()) throw new Error('Unsupported terminal checkpoint: protected cell')
  const extended = value.hasExtendedAttrs?.() ? value.extended : undefined
  if (extended?.underlineVariantOffset) throw new Error('Unsupported terminal checkpoint: underline variant')
  const style = value.getUnderlineStyle?.() ?? 0
  const codes = [0]
  const flags: [('isBold' | 'isDim' | 'isItalic' | 'isBlink' | 'isInverse' | 'isInvisible' | 'isStrikethrough' | 'isOverline'), number][] = [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9], ['isOverline', 53]]
  for (const [key, code] of flags) {
    const flag = value[key]
    if (typeof flag === 'function' && flag.call(value)) codes.push(code)
  }
  for (const fg of [true, false]) {
    const color = fg ? value.getFgColor() : value.getBgColor()
    if (fg ? value.isFgRGB() : value.isBgRGB()) codes.push(fg ? 38 : 48, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255)
    else if (fg ? value.isFgPalette() : value.isBgPalette()) codes.push(fg ? 38 : 48, 5, color)
  }
  let data = `\x1b[${codes.join(';')}m\x1b[4:${style}m`
  const color = extended?.underlineColor ?? 0
  const mode = color & 0x03000000
  if (mode === 0x03000000) data += `\x1b[58:2::${(color >>> 16) & 255}:${(color >>> 8) & 255}:${color & 255}m`
  else if (mode) data += `\x1b[58:5:${color & 255}m`

  const id = extended?.urlId ?? 0
  if (id) {
    const core = (terminal as unknown as { _core: { _oscLinkService: { getLinkData(id: number): { uri: string; id?: string } | undefined } } })._core
    const link = core._oscLinkService.getLinkData(id)
    if (!link || /[\x00-\x1f\x7f]/.test(link.uri) || (link.id && /[\x00-\x1f\x7f:;]/.test(link.id))) throw new Error('Unsupported terminal checkpoint: invalid link')
    data += `\x1b]8;${link.id ? 'id=' + link.id : ''};${link.uri}\x1b\\`
  } else data += '\x1b]8;;\x1b\\'
  return data
}
