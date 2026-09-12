import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createServer as createViteServer } from 'vite'
import * as pty from 'node-pty'
import { SessionLog } from './session.ts'
import { createRelay } from './relay.ts'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.ORCHESTRA_LAB_PORT ?? 4381)
const token = randomBytes(24).toString('hex')
const session = await SessionLog.open({ cols: 80, rows: 24 })
const fixture = pty.spawn(process.execPath, [fileURLToPath(new URL('fixture.cjs', import.meta.url))], {
  cols: 80, rows: 24, name: 'xterm-256color', cwd: root,
  env: { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
})
let failure: string | null = null
let pending = 0
let stopping = false
fixture.onData(data => {
  if (stopping || failure) return
  const bytes = Buffer.from(data)
  pending += bytes.length
  if (pending > 128 * 1024) fixture.pause()
  void session.append(bytes).catch(error => {
    failure = String(error); fixture.pause(); console.error(failure)
  }).finally(() => { pending -= bytes.length; if (!stopping && !failure && pending < 32 * 1024) fixture.resume() })
})
const http = createServer()
const vite = await createViteServer({
  configFile: false, root, appType: 'spa',
  server: { middlewareMode: true, hmr: { server: http }, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
})
http.on('request', (request, response) => {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(request.headers.host ?? '')) { response.writeHead(403); response.end(); return }
  if (request.url === '/session') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ token, epoch: session.epoch, head: session.head, ...session.metrics, failure }))
    return
  }
  vite.middlewares(request, response)
})
const relay = createRelay(http, session, { token, input: data => fixture.write(data), resize: (cols, rows) => fixture.resize(cols, rows) })
http.listen(port, '127.0.0.1', () => console.log(`Terminal stream lab: http://127.0.0.1:${port}\nSynthetic PTY only; Ctrl-C stops it and removes the scratch archive.`))
async function close() {
  if (stopping) return
  stopping = true
  relay.close(); fixture.kill()
  await vite.close()
  http.closeAllConnections()
  await new Promise<void>(resolve => http.close(() => resolve()))
  await session.close()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
http.once('error', error => { console.error(error); void close() })
