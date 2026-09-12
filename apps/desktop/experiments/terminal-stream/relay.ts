import type { Server, IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { SessionLog } from './session.ts'
import { decodeFrame, HEADER_BYTES, MAX_PAYLOAD, type Cursor } from './protocol.ts'

type Options = {
  token: string
  windowBytes?: number
  input?: (data: string) => void
  resize?: (cols: number, rows: number) => void
}

export function createRelay(server: Server, session: SessionLog, options: Options) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false })
  const windowBytes = Math.max(HEADER_BYTES + MAX_PAYLOAD, Math.min(options.windowBytes ?? 64 * 1024, 64 * 1024))
  let controller: WebSocket | null = null
  let lease = 0
  let controlChain = Promise.resolve()
  let pendingControls = 0
  const json = (ws: WebSocket, message: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)) }
  const publishLease = () => { for (const ws of wss.clients) json(ws, { type: 'lease', lease, controller: ws === controller }) }
  function reject(ws: WebSocket, error: unknown) {
    json(ws, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    ws.close(1008, 'Session protocol rejected')
  }
  const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/stream') return
    const host = request.headers.host
    const origin = request.headers.origin
    if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host) || origin !== `http://${host}` || url.searchParams.get('token') !== options.token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  }
  server.on('upgrade', upgrade)
  wss.on('connection', ws => {
    let attached = false
    let next = 1n
    let acked = 0n
    let outstanding = 0
    let pumping = false
    let dirty = false
    let closed = false
    let lastInput = 0
    let appliedInput = 0
    const sent = new Map<bigint, { size: number; offset: bigint }>()
    const timer = setTimeout(() => reject(ws, 'Attach timed out'), 5000)
    const pump = () => {
      dirty = true
      if (pumping || !attached || closed) return
      pumping = true
      void (async () => {
        do {
          dirty = false
          while (!closed && ws.readyState === WebSocket.OPEN) {
            const frame = await session.read(next)
            if (!frame || closed || outstanding + frame.length > windowBytes) break
            const event = decodeFrame(frame)
            outstanding += frame.length
            sent.set(next, { size: frame.length, offset: event.offset })
            next++
            ws.send(frame, { binary: true }, error => { if (error) ws.terminate() })
          }
        } while (dirty && !closed)
      })().catch(error => reject(ws, error)).finally(() => { pumping = false })
    }
    const unsubscribe = session.subscribe(pump)
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('Client commands must be JSON')
        const message = JSON.parse(data.toString())
        if (message.type === 'attach') {
          if (attached) throw new Error('Already attached')
          const cursor: Cursor = { seq: message.seq, offset: message.offset }
          if (typeof cursor.seq !== 'string' || typeof cursor.offset !== 'string' || !session.validCursor(cursor)) throw new Error('Invalid resume cursor')
          if (message.epoch !== session.epoch && !(message.epoch === null && cursor.seq === '0' && cursor.offset === '0')) throw new Error('Session incarnation changed; open a fresh viewer')
          attached = true; clearTimeout(timer)
          acked = BigInt(cursor.seq); next = acked + 1n
          json(ws, { type: 'ready', epoch: session.epoch, initial: session.initial, head: session.head, windowBytes })
          json(ws, { type: 'lease', lease, controller: false })
          pump()
        } else if (!attached) {
          throw new Error('Attach first')
        } else if (message.type === 'ack') {
          if (typeof message.seq !== 'string' || !/^\d{1,20}$/.test(message.seq) || typeof message.offset !== 'string' || !/^\d{1,20}$/.test(message.offset)) throw new Error('Invalid acknowledgement')
          const seq = BigInt(message.seq)
          if (seq <= acked) return
          const entry = sent.get(seq)
          if (!entry || entry.offset !== BigInt(message.offset)) throw new Error('Acknowledged unsent output')
          for (const [key, value] of sent) { if (key <= seq) { outstanding -= value.size; sent.delete(key) } }
          acked = seq
          pump()
        } else if (message.type === 'claim') {
          controller = ws; lease++; publishLease()
        } else if (message.type === 'input' || message.type === 'resize') {
          if (controller !== ws || message.lease !== lease) { json(ws, { type: 'denied', message: 'Take control before sending input or resizing' }); return }
          if (!Number.isSafeInteger(message.id) || message.id < 1 || message.id > lastInput + 1) throw new Error('Invalid input sequence')
          if (message.id <= lastInput) {
            if (message.id <= appliedInput) json(ws, { type: 'input-ack', id: message.id })
            return
          }
          if (message.type === 'input' && (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 4096)) throw new Error('Input too large')
          if (pendingControls >= 64) throw new Error('Control queue limit reached')
          lastInput = message.id
          pendingControls++
          const acceptedLease = lease
          controlChain = controlChain.then(async () => {
            if (closed || controller !== ws || lease !== acceptedLease) { json(ws, { type: 'denied', message: 'Control changed before input was applied' }); return }
            if (message.type === 'input') options.input?.(message.data)
            else await session.resize(message.cols, message.rows, () => options.resize?.(message.cols, message.rows))
            appliedInput = message.id
            json(ws, { type: 'input-ack', id: message.id })
          }).catch(error => reject(ws, error)).finally(() => { pendingControls-- })
        } else throw new Error('Unknown command')
      } catch (error) { reject(ws, error) }
    })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      closed = true; clearTimeout(timer); unsubscribe(); sent.clear()
      if (controller === ws) { controller = null; lease++; publishLease() }
    })
  })
  return {
    close() { server.off('upgrade', upgrade); for (const ws of wss.clients) ws.terminate(); wss.close() },
  }
}
