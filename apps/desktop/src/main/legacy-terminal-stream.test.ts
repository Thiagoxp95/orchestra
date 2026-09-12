import { afterEach, expect, it } from 'vitest'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonParser, sendJson } from '../daemon/protocol'
import { openLegacyTerminalStream } from './legacy-terminal-stream'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

async function daemon(snapshot: object | null) {
  const path = join(tmpdir(), `o-${randomUUID().slice(0, 8)}.sock`)
  let stream!: net.Socket
  const sockets: net.Socket[] = []
  const requests: string[] = []
  const server = net.createServer(socket => {
    sockets.push(socket)
    socket.setEncoding('utf8')
    socket.on('data', createJsonParser(msg => {
      requests.push(msg.type)
      if (msg.type === 'hello' && msg.role === 'stream') stream = socket
      if (msg.type === 'createOrAttach') {
        sendJson(stream, { type: 'event', event: 'data', sessionId: 'agent', data: 'first' })
      }
      sendJson(socket, { id: msg.id, ok: true, snapshot })
    }))
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  cleanup.push(() => { sockets.forEach(s => s.destroy()); server.close() })
  return { path, requests, sockets, emit(data: string) {
    sendJson(stream, { type: 'event', event: 'data', sessionId: 'agent', data })
  } }
}

it('subscribes independently of the desktop and preserves output arriving with the seed', async () => {
  const snapshot = { snapshotAnsi: 'seed', rehydrateSequences: '', cwd: '/tmp', cols: 80, rows: 24 }
  const host = await daemon(snapshot)
  const output: string[] = []
  const connection = await openLegacyTerminalStream('agent', data => output.push(data), () => {}, host.path)
  cleanup.push(connection.dispose)
  expect(connection.snapshot).toEqual(snapshot)
  host.emit('second')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(output.join('')).toBe('firstsecond')
  expect(host.requests).toContain('createOrAttach')
  connection.dispose()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(host.sockets.every(s => s.destroyed)).toBe(true)
})

it('does not recreate a missing agent when subscribing', async () => {
  const host = await daemon(null)
  await expect(openLegacyTerminalStream('missing', () => {}, () => {}, host.path)).rejects.toThrow('not running')
  expect(host.requests).not.toContain('createOrAttach')
})
