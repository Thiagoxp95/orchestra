import { expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'
const write = (t: Terminal, data: string) => new Promise<void>(r => t.write(data, r))
function cells(t: Terminal) {
  const core = (t as any)._core
  const b = t.buffer.active
  return Array.from({ length: b.length }, (_, y) => {
    const line = b.getLine(y)!
    return Array.from({ length: t.cols }, (_, x) => {
      const c = line.getCell(x) as any
      return { chars: c.getChars(), width: c.getWidth(), fg: c.getFgColor(), bg: c.getBgColor(), underline: c.getUnderlineStyle(), color: c.hasExtendedAttrs() ? c.extended.underlineColor : 0, link: c.hasExtendedAttrs() && c.extended.urlId ? core._oscLinkService.getLinkData(c.extended.urlId)?.uri : null }
    })
  })
}
it.each([
  ['plain underline', '\x1b[4mUNDERLINED\x1b[0m plain'],
  ['curly colored underline', '\x1b[4:3;58:2::10:20:30mUNDERLINED\x1b[0m plain'],
  ['closed link', '\x1b]8;id=doc;https://example.com\x1b\\linked 😀 text\x1b]8;;\x1b\\ plain'],
  ['open link', '\x1b]8;;https://example.com\x1b\\open link'],
  ['saved linked style', '\x1b]8;;https://example.com\x1b\\link\x1b7\x1b]8;;\x1b\\ plain\x1b8'],
])('preserves %s cells and continuation', async (_name, input) => {
  const e = new HeadlessEmulator(30, 8, '/tmp')
  const source = new Terminal({ cols: 30, rows: 8, allowProposedApi: true })
  const target = new Terminal({ cols: 30, rows: 8, allowProposedApi: true })
  try {
    const before = ('history line\r\n').repeat(20) + input
    e.write(before); await write(source, before)
    const seed = await e.getStreamSnapshotAsync()
    await write(target, seed.data)
    expect(cells(target)).toEqual(cells(source))
    const suffix = ' NEXT\x1b]8;;\x1b\\\x1b[0m\r\nend'
    await write(target, suffix); await write(source, suffix)
    expect(cells(target)).toEqual(cells(source))
    expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX)
    expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY)
  } finally { e.dispose(); source.dispose(); target.dispose() }
})
