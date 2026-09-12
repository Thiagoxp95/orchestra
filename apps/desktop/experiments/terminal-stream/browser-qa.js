// Run only through Aside: aside repl "$(cat apps/desktop/experiments/terminal-stream/browser-qa.js)"
const p = await openTab('http://127.0.0.1:4381')
try {
  await p.waitForSelector('.metrics')
  console.log(await p.evaluate(async () => {
    const wait = async (predicate, message) => {
      const deadline = performance.now() + 15000
      while (!await predicate()) {
        if (performance.now() > deadline) throw new Error(message)
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }
    await wait(() => window.terminalLab?.views.every(v => v.connection.connected), 'viewers did not connect')
    const [a, b] = window.terminalLab.views
    await wait(() => a.connection.controller, 'automatic web ownership failed')
    await new Promise(resolve => setTimeout(resolve, 500))
    const settled = () => a.connection.applier.cursor.seq === b.connection.applier.cursor.seq && a.connection.applier.pendingBytes === 0 && b.connection.applier.pendingBytes === 0
    const top = v => v.terminal.buffer.active.getLine(v.terminal.buffer.active.viewportY)?.translateToString(true)
    const screen = v => {
      const buffer = v.terminal.buffer.active
      return JSON.stringify({ cursor: [buffer.cursorX, buffer.cursorY], modes: v.terminal.modes,
        rows: Array.from({ length: v.terminal.rows }, (_, row) => {
          const line = buffer.getLine(buffer.baseY + row)
          return Array.from({ length: v.terminal.cols }, (_, col) => {
            const cell = line?.getCell(col)
            return cell && [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isInverse()]
          })
        }),
      })
    }
    document.querySelector('[data-command="burst 5000"]').click()
    await wait(() => a.terminal.buffer.active.baseY > 4500 && settled(), 'large output did not arrive')
    b.terminal.scrollToLine(Math.max(0, b.terminal.buffer.active.baseY - 3000))
    const anchor = top(b)
    const before = a.connection.applier.cursor.seq
    document.querySelector('[data-command="stream"]').click()
    await wait(() => BigInt(a.connection.applier.cursor.seq) > BigInt(before) + 10n, 'live stream did not advance')
    if (top(b) !== anchor) throw new Error('History anchor moved during live output')
    b.connection.reconnect()
    await wait(() => !b.connection.connected, 'reconnect did not disconnect')
    await wait(() => b.connection.connected && settled(), 'retained-offset reconnect did not converge')
    if (top(b) !== anchor) throw new Error('History anchor moved during reconnect')
    document.querySelector('[data-command="stop"]').click()
    await new Promise(resolve => setTimeout(resolve, 250))
    await wait(settled, 'viewers did not settle')
    if (screen(a) !== screen(b)) throw new Error('Visible terminal cells diverged')
    const saved = { historyAnchor: anchor, anchorAfterReconnect: top(b), matchedScreen: true, cursor: a.connection.applier.cursor, geometry: [a.terminal.cols, a.terminal.rows] }
    document.querySelector('[data-command="alt"]').click()
    await wait(() => a.terminal.buffer.active.type === 'alternate' && b.terminal.buffer.active.type === 'alternate' && settled(), 'alternate screen did not match')
    if (screen(a) !== screen(b)) throw new Error('Alternate screen differs')
    document.querySelector('[data-command="normal"]').click()
    await wait(() => a.terminal.buffer.active.type === 'normal' && b.terminal.buffer.active.type === 'normal' && settled(), 'normal buffer did not restore')
    const oldCols = a.terminal.cols
    const firstPanel = document.querySelector('.viewer')
    firstPanel.style.width = '430px'
    await wait(() => a.terminal.cols !== oldCols && a.terminal.cols === b.terminal.cols && settled(), 'automatic viewport reflow did not reach both viewers')
    saved.reflowedGeometry = [a.terminal.cols, a.terminal.rows]
    firstPanel.style.width = ''
    await wait(() => a.terminal.cols === oldCols && settled(), 'automatic geometry restore did not converge')
    b.connection.delayMs = 500
    const startFast = BigInt(a.connection.applier.cursor.seq)
    document.querySelector('[data-command="burst 5000"]').click()
    await wait(() => BigInt(a.connection.applier.cursor.seq) > startFast + 5n && BigInt(a.connection.applier.cursor.seq) > BigInt(b.connection.applier.cursor.seq), 'slow viewer did not lag independently')
    saved.slowViewerIsolation = true
    b.connection.delayMs = 0
    await wait(settled, 'slow viewer did not catch up')
    if (screen(a) !== screen(b)) throw new Error('Recovered slow viewer differs')
    a.connection.reconnect()
    await wait(() => !a.connection.connected, 'controller did not disconnect')
    await wait(() => a.connection.connected && a.connection.controller && settled(), 'active web viewer did not automatically reclaim control after reconnect')
    saved.controllerReclaimed = true
    return saved
  }))
  await p.screenshot({ path: '/tmp/orchestra-terminal-stream-lab.png' })
} finally { await p.close() }
