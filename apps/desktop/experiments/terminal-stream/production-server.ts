// Disposable integration harness using production daemon, host, relay and client.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import * as pty from 'node-pty'
import { TerminalStream } from '../../src/daemon/terminal-stream'
import { HeadlessEmulator } from '../../src/daemon/headless-emulator'
import { TerminalStreamHost } from '../../src/main/terminal-stream-host'
import { createRelay } from '../../../terminal-relay/src/relay'
const root = resolve('apps/desktop/experiments/terminal-stream')
const port = Number(process.env.ORCHESTRA_PRODUCTION_LAB_PORT ?? 4382)
const token = randomBytes(24).toString('hex')
const secret = randomBytes(24).toString('hex')
const log = new TerminalStream()
const fixture = pty.spawn(process.execPath, [resolve(root, 'fixture.cjs')], { cols: 80, rows: 24, name: 'xterm-256color', cwd: root, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })
const emulator = new HeadlessEmulator(80, 24, '/synthetic', paused => paused ? fixture.pause() : fixture.resume())
fixture.onData(data => { log.append(data); emulator.write(data) })
const relay = createRelay({ secret, origins: [`http://127.0.0.1:${port}`], authorize: async (value, id) => { if (value !== token || id !== 'synthetic') throw new Error('Unauthorized') } })
await new Promise<void>(r => relay.server.listen(port + 1, '127.0.0.1', r))
const host = new TerminalStreamHost({ secret, endpoint: `ws://127.0.0.1:${port + 1}`, onGeometry() {}, daemon: {
  supportsTerminalStream: () => true,
  getTerminalStreamCheckpoint: async () => { const cut = log.head; const pending = emulator.getStreamSnapshotAsync(); return { epoch: log.epoch, ...cut, ...await pending } },
  readTerminalStream: async (_id, epoch, seq, max, offset) => log.read(epoch, seq, max, offset),
  write: (_id, data) => fixture.write(data),
  resize: async (_id, cols, rows) => { log.resize(cols, rows); emulator.resize(cols, rows); fixture.resize(cols, rows) },
} })
const http = createServer()
const vite = await createViteServer({ configFile: false, root, appType: 'mpa', server: { middlewareMode: true, hmr: { server: http }, fs: { allow: [process.cwd()] } } })
http.on('request', (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return }
  if (req.url === '/production-session') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ token, endpoint: `ws://127.0.0.1:${port + 1}`, head: log.head, retainedBytes: log.bytes, pendingBytes: emulator.pendingBytes })); return }
  vite.middlewares(req, res)
})
http.listen(port, '127.0.0.1', () => console.log(`Production terminal lab: http://127.0.0.1:${port}/production.html (synthetic PTY only)`))
let closing = false
async function close() {
  if (closing) return
  closing = true; host.dispose(); fixture.kill(); emulator.dispose(); await relay.close(); await vite.close(); http.closeAllConnections(); http.close()
}
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close())
