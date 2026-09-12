import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { DAEMON_SOCKET_PATH, createJsonParser, sendJson, type DaemonResponse, type SessionSnapshot } from '../daemon/protocol'

/** A viewer owns its daemon sockets so desktop pane detaches cannot silence it. */
export async function openLegacyTerminalStream(
  sessionId: string,
  onData: (data: string) => void,
  onError: (error: Error) => void,
  socketPath = DAEMON_SOCKET_PATH,
): Promise<{ snapshot: SessionSnapshot; dispose(): void }> {
  const clientId = randomUUID()
  const control = net.createConnection(socketPath)
  const stream = net.createConnection(socketPath)
  let stopped = false
  let ready = false
  let nextId = 0
  const pending = new Map<number, { resolve(value: DaemonResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const dispose = () => {
    if (stopped) return
    stopped = true
    control.destroy()
    stream.destroy()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Terminal subscription closed'))
    }
    pending.clear()
  }
  const fail = (error: Error) => {
    if (stopped) return
    dispose()
    if (ready) onError(error)
  }
  const parseResponse = (msg: DaemonResponse) => {
    const request = pending.get(Number(msg.id))
    if (!request) return
    pending.delete(Number(msg.id))
    clearTimeout(request.timer)
    if (msg.ok) request.resolve(msg)
    else request.reject(new Error(msg.error || 'Terminal subscription failed'))
  }
  control.setEncoding('utf8')
  stream.setEncoding('utf8')
  control.on('data', createJsonParser(parseResponse))
  stream.on('data', createJsonParser(msg => {
    if (msg.type === 'event' && msg.event === 'data' && msg.sessionId === sessionId) onData(msg.data)
    else parseResponse(msg)
  }))
  for (const socket of [control, stream]) {
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('Terminal subscription disconnected')))
  }
  const request = (socket: net.Socket, body: object): Promise<DaemonResponse> => new Promise((resolve, reject) => {
    if (stopped) { reject(new Error('Terminal subscription closed')); return }
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Terminal subscription timed out')) }, 10_000)
    pending.set(id, { resolve, reject, timer })
    sendJson(socket, { ...body, id })
  })
  try {
    await Promise.all([
      request(control, { type: 'hello', role: 'control', clientId }),
      request(stream, { type: 'hello', role: 'stream', clientId }),
    ])
    const current = await request(control, { type: 'getSnapshot', sessionId })
    if (!current.snapshot) throw new Error('Terminal is not running')
    const { cwd, cols, rows } = current.snapshot as SessionSnapshot
    const attached = await request(control, { type: 'createOrAttach', sessionId, cwd, cols, rows })
    if (!attached.snapshot) throw new Error('Terminal subscription has no snapshot')
    ready = true
    return { snapshot: attached.snapshot, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
