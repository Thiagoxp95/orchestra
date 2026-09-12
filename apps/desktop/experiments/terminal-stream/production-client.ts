import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { TerminalApplier } from '../../../web/src/lib/terminal-stream/applier'
import { TerminalConnection, type StreamSocket } from '../../../web/src/lib/terminal-stream/connection'
import './style.css'
await document.fonts.load('14px "Orchestra Mono"')
const config = await fetch('/production-session').then(r => r.json())
let active = 0
const views = ['A', 'B'].map((name, index) => {
  const panel = document.createElement('section'); panel.className = 'viewer'
  panel.innerHTML = `<header><h2>Viewer ${name}</h2><button data-claim>Activate</button><button data-reconnect>Reconnect</button></header><div class="terminal-viewport"></div><pre class="metrics"></pre>`
  document.querySelector('#viewers')!.append(panel)
  const viewport = panel.querySelector<HTMLElement>('.terminal-viewport')!
  function create() {
    const element = document.createElement('div'); element.className = 'terminal-host'; viewport.append(element)
    const t = new Terminal({ cols: 80, rows: 24, fontFamily: '"Orchestra Mono", monospace', fontSize: 14, scrollback: 10000, cursorBlink: false, allowProposedApi: true, theme: { background: '#11171b', foreground: '#dce6e9' } })
    t.open(element)
    try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); t.loadAddon(gl) } catch {}
    return { terminal: t, element }
  }
  let current = create()
  let ws: WebSocket
  let delay = 0
  let status = ''
  const applier = new TerminalApplier({ current: () => current.terminal, stage() {
    const next = create(); next.element.style.position = 'absolute'; next.element.style.visibility = 'hidden'
    return { terminal: next.terminal, commit() { current.terminal.dispose(); current.element.remove(); current = next; next.element.style.position = ''; next.element.style.visibility = ''; fit() }, dispose() { next.terminal.dispose(); next.element.remove() } }
  } })
  const connection = new TerminalConnection({ token: config.token, sessionId: 'synthetic', applier, url: config.endpoint,
    onStatus(value) { status = value }, onController() { fit() },
    socketFactory(url) {
      ws = new WebSocket(url)
      const send = ws.send.bind(ws)
      ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        if (delay && typeof data === 'string' && JSON.parse(data).type === 'ack') {
          const socket = ws; setTimeout(() => { if (socket.readyState === WebSocket.OPEN) send(data) }, delay)
        } else send(data)
      }
      return ws as unknown as StreamSocket
    },
  })
  function fit() {
    const t = current.terminal
    const rect = t.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
    if (!rect?.width) return
    connection.resize(Math.max(2, Math.min(500, Math.floor((viewport.clientWidth - 24) / (rect.width / t.cols)))), Math.max(2, Math.floor((viewport.clientHeight - 24) / (rect.height / t.rows))))
  }
  new ResizeObserver(fit).observe(viewport)
  connection.setActive(index === active); connection.start()
  panel.querySelector('[data-claim]')!.addEventListener('click', () => { active = index; for (const [i, v] of views.entries()) v.connection.setActive(i === active); connection.claim() })
  panel.querySelector('[data-reconnect]')!.addEventListener('click', () => ws.close())
  setInterval(() => { panel.querySelector('.metrics')!.textContent = `${status || 'Live'} · ${connection.isController ? 'controller' : 'viewer'}\nseq ${applier.applied.seq} · ${applier.applied.offset} bytes · ${applier.pendingBytes} queued\n${current.terminal.cols}×${current.terminal.rows} · viewport ${current.terminal.buffer.active.viewportY}/${current.terminal.buffer.active.baseY}` }, 200)
  return { connection, applier, get terminal() { return current.terminal }, disconnect: () => ws.close(), slow: (ms: number) => { delay = ms }, panel }
})
document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach(b => b.onclick = () => { views[active].connection.input(b.dataset.command! + '\r') })
;(window as any).lab = { views, command: (data: string) => views[active].connection.input(data + '\r') }
