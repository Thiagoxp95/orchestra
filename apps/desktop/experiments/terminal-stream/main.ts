import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { TerminalConnection } from './connection.ts'
import './style.css'

await document.fonts.load('13px "Orchestra Mono"')
const config = await fetch('/session').then(response => response.json())
const endpoint = `ws://${location.host}/stream?token=${encodeURIComponent(config.token)}`
const notice = document.querySelector<HTMLElement>('#notice')!
let activeView = 'A'
const views = ['A', 'B'].map(label => {
  const panel = document.createElement('section')
  panel.className = 'viewer'
  panel.innerHTML = `
    <header><h2>Viewer ${label}</h2><div class="controls">
      <button type="button" data-action="claim">Take control</button>
      <button type="button" data-action="reconnect">Reconnect</button>
      <button type="button" data-action="latest">Latest</button>
      <label><input type="checkbox" data-action="slow">Slow acknowledgements</label>
    </div></header>
    <div class="terminal-viewport"><div class="terminal-host" aria-label="Terminal viewer ${label}"></div></div>
    <pre class="metrics" aria-label="Viewer ${label} stream metrics"></pre>`
  document.querySelector('#viewers')!.append(panel)
  const terminal = new Terminal({
    cols: 80, rows: 24, fontFamily: '"Orchestra Mono", monospace', fontSize: 13,
    scrollback: 10000, cursorBlink: false, convertEol: false, smoothScrollDuration: 0,
    allowProposedApi: true, theme: { background: '#11171b', foreground: '#dce6e9', cursor: '#a5dcc7' },
  })
  terminal.open(panel.querySelector<HTMLElement>('.terminal-host')!)
  let renderer = 'DOM'
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => { webgl.dispose(); renderer = 'DOM fallback' })
    terminal.loadAddon(webgl); renderer = 'WebGL'
  } catch { /* xterm's default renderer remains usable. */ }
  const metrics = panel.querySelector<HTMLElement>('.metrics')!
  const claim = panel.querySelector<HTMLButtonElement>('[data-action="claim"]')!
  const viewport = panel.querySelector<HTMLElement>('.terminal-viewport')!
  let fitTimer: ReturnType<typeof setTimeout> | undefined
  let previouslyConnected = false
  let previouslyControlled = false
  const fit = () => {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(() => {
      if (!connection.controller || document.visibilityState !== 'visible') return
      const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) return
      const rect = screen.getBoundingClientRect()
      const cellWidth = rect.width / terminal.cols; const cellHeight = rect.height / terminal.rows
      if (!cellWidth || !cellHeight) return
      const cols = Math.max(2, Math.min(500, Math.floor((viewport.clientWidth - 24) / cellWidth)))
      const rows = Math.max(2, Math.min(200, Math.floor((viewport.clientHeight - 24) / cellHeight)))
      if (cols !== terminal.cols || rows !== terminal.rows) connection.resize(cols, rows)
    }, 120)
  }
  // A bounded timer updates diagnostics; terminal bytes never enter UI state.
  const connection = new TerminalConnection(terminal, endpoint, () => {
    if (connection.connected && !previouslyConnected) {
      if (activeView === label && document.visibilityState === 'visible') connection.claim()
    }
    previouslyConnected = connection.connected
    if (connection.controller && !previouslyControlled) fit()
    previouslyControlled = connection.controller
  })
  const render = () => {
    const buffer = terminal.buffer.active
    const cursor = connection.applier.cursor
    metrics.textContent = `${connection.message} · ${connection.controller ? 'controller' : 'viewer'} · ${renderer}\nApplied event ${cursor.seq} · UTF-8 bytes ${cursor.offset} · queued ${connection.applier.pendingBytes}\nGrid ${terminal.cols}×${terminal.rows} · viewport ${buffer.viewportY}/${buffer.baseY} · ${buffer.type}`
    claim.textContent = connection.controller ? 'In control' : 'Take control'
    claim.disabled = connection.controller || !connection.connected
  }
  const timer = setInterval(render, 200)
  const activate = () => { activeView = label; if (!connection.controller) connection.claim() }
  claim.onclick = activate
  terminal.element!.addEventListener('focusin', activate)
  const observer = new ResizeObserver(fit)
  observer.observe(viewport)
  panel.querySelector<HTMLButtonElement>('[data-action="reconnect"]')!.onclick = () => connection.reconnect()
  panel.querySelector<HTMLButtonElement>('[data-action="latest"]')!.onclick = () => terminal.scrollToBottom()
  panel.querySelector<HTMLInputElement>('[data-action="slow"]')!.onchange = event => { connection.delayMs = (event.target as HTMLInputElement).checked ? 500 : 0 }
  terminal.onData(data => { if (connection.controller) connection.input(data) })
  return { terminal, connection, fit, dispose() { observer.disconnect(); clearTimeout(fitTimer); clearInterval(timer); connection.dispose(); terminal.dispose() } }
})
const foreground = () => {
  if (document.visibilityState !== 'visible') return
  const view = views[activeView === 'A' ? 0 : 1]
  if (view.connection.connected) { view.connection.claim(); view.fit() }
}
document.addEventListener('visibilitychange', foreground)
window.addEventListener('focus', foreground)
function input(data: string) {
  const view = views.find(view => view.connection.controller)
  if (!view) { notice.textContent = 'Take control in either viewer first.'; return }
  view.connection.input(data)
  notice.textContent = 'Synthetic workload sent. The other viewer can scroll independently.'
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) button.onclick = () => input(`${button.dataset.command}\r`)
document.querySelector<HTMLButtonElement>('#interrupt')!.onclick = () => input('\x03')
const archiveTimer = setInterval(() => {
  void fetch('/session').then(response => response.json()).then(status => {
    document.querySelector('#archive')!.textContent = `Archive: ${(status.archiveBytes / 1024).toFixed(1)} KiB · ${status.events} events · producer pending ${status.pendingBytes} bytes${status.failure ? ` · ${status.failure}` : ''}`
  }).catch(() => { document.querySelector('#archive')!.textContent = 'Session host unavailable' })
}, 1000)
// The lab intentionally exposes its real viewers for repeatable browser QA.
Object.assign(window, { terminalLab: { views } })
window.addEventListener('beforeunload', () => { clearInterval(archiveTimer); for (const view of views) view.dispose() })
