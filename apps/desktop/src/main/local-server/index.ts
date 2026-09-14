// src/main/local-server/index.ts
//
// The server the phone talks to. One HTTP listener on loopback, published to
// the tailnet by Tailscale Serve, carrying everything the web app needs:
//
//   GET  /*            the web app itself (static export, shipped in this app)
//   GET  /api/config   runtime settings the bundle can't be built with
//   POST /api/upload   pasted images
//   POST /webhook/:t   inbound webhooks
//   WS   /api/sync     reactive reads and all writes
//   WS   /viewer       terminal output  ─┐ the former apps/terminal-relay,
//   WS   /host         terminal input   ─┘ now on this same listener
//
// This replaces a Convex deployment, a `next start` process, and a relay
// process with one server inside Electron. Nothing leaves the machine, so
// there is no deployment to configure and no shared secret to distribute.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { app } from 'electron'
import {
  SYNC_PATH,
  SYNC_PROTOCOL_VERSION,
  type SyncClientMessage,
  type SyncServerMessage,
} from '../../shared/sync-protocol'
import { registerApi } from './api'
import { createRelay, type Relay } from './relay'
import { SyncHub, type Subscriber } from './sync-hub'
import { createStaticHandler } from './static-files'
import { getVapidPublicKey } from './push'
import * as state from './runtime-state'
import { isAllowedUploadMime, MAX_UPLOAD_BYTES, reapUploads, storeUpload } from './uploads'
import { reapWebhookEvents, receiveWebhook } from './webhook-intake'
import type { WebhookEventRow } from './durable-store'

/** Loopback port. Tailscale Serve fronts this; it is never bound publicly. */
export const LOCAL_SERVER_PORT = Number(process.env.ORCHESTRA_LOCAL_WEB_PORT) || 13000

const MAX_SYNC_MESSAGE = 128 * 1024
const MAX_SUBSCRIPTIONS = 64

export interface LocalServerOptions {
  /** Directory holding the exported web app. Defaults to the bundled copy. */
  webRoot?: string
  /** Notified when a webhook event is queued, so the runner can pick it up. */
  onWebhookEvent?: (event: WebhookEventRow) => void
}

export interface LocalServer {
  readonly port: number
  /** The relay host secret, for the in-process TerminalStreamHost. */
  readonly hostSecret: string
  close: () => Promise<void>
}

let running: LocalServer | null = null

/** Where the static web export lives, bundled in the app or built in the repo. */
function defaultWebRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web')
    : join(app.getAppPath(), '..', 'web', 'out')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read a bounded request body. Rejects rather than buffering without limit. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > limit) throw new Error('Payload too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * Accept a WebSocket only from a page this server served.
 *
 * There is no cookie or token to steal, so this is defence in depth rather
 * than the security boundary — the tailnet is. It costs nothing and keeps a
 * random web page a phone happens to visit from opening a terminal.
 */
function sameOrigin(origin: string | undefined, req: IncomingMessage): boolean {
  // Non-browser clients (the in-process host) send no Origin at all.
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServer> {
  if (running) return running

  const hub = new SyncHub()
  state.setInvalidator((...names) => hub.invalidate(...names))
  registerApi(hub)

  const relay = createRelay({
    // A viewer may only attach to a session the phone can already see in the
    // state mirror. That is the same visibility the old session token granted,
    // derived from live state instead of a stored row.
    authorize: (sessionId) => {
      if (!state.hasMirroredSession(sessionId)) throw new Error('Unknown session')
    },
    allowOrigin: sameOrigin,
  })

  const serveStatic = createStaticHandler(options.webRoot ?? defaultWebRoot())

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' })
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname

    if (path === '/api/config' && req.method === 'GET') {
      // The bundle is built once and shipped; anything machine-specific has to
      // be fetched at runtime, which is also why there is no VAPID env var.
      sendJson(res, 200, { vapidPublicKey: getVapidPublicKey() })
      return
    }

    if (path === '/api/upload' && req.method === 'POST') {
      const mime = (req.headers['content-type'] ?? '').split(';')[0].trim()
      if (!isAllowedUploadMime(mime)) {
        sendJson(res, 415, { error: 'Unsupported image type' })
        return
      }
      let bytes: Buffer
      try {
        bytes = await readBody(req, MAX_UPLOAD_BYTES)
      } catch {
        sendJson(res, 413, { error: 'Image too large' })
        return
      }
      if (bytes.length === 0) {
        sendJson(res, 400, { error: 'Empty upload' })
        return
      }
      sendJson(res, 200, { storageId: await storeUpload(bytes, mime) })
      return
    }

    if (path.startsWith('/webhook/') && req.method === 'POST') {
      let body: Buffer
      try {
        body = await readBody(req, 1024 * 1024)
      } catch {
        sendJson(res, 413, { error: 'Payload too large' })
        return
      }
      const result = await receiveWebhook(decodeURIComponent(path.slice('/webhook/'.length)), body.toString('utf8'))
      if (result.event) options.onWebhookEvent?.(result.event)
      sendJson(res, result.status, result.body)
      return
    }

    if (await serveStatic(req, res, path)) return
    sendJson(res, 404, { error: 'Not found' })
  }

  // ── Sync sockets ───────────────────────────────────────────────────────

  const syncSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_SYNC_MESSAGE })

  syncSockets.on('connection', (ws: WebSocket) => {
    const send = (message: SyncServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    }
    const subscriber: Subscriber = {
      value: (id, value) => send({ t: 'value', id, value }),
      error: (id, message) => send({ t: 'err', id, message }),
    }
    hub.connect(subscriber)
    const open = new Set<number>()

    send({ t: 'ready', protocol: SYNC_PROTOCOL_VERSION, buildId: '' })

    ws.on('message', (raw) => {
      let message: SyncClientMessage
      try {
        message = JSON.parse(raw.toString())
      } catch {
        ws.close(1008, 'Invalid message')
        return
      }
      switch (message.t) {
        case 'ping':
          send({ t: 'pong' })
          return
        case 'sub': {
          if (open.size >= MAX_SUBSCRIPTIONS) {
            send({ t: 'err', id: message.id, message: 'Too many subscriptions' })
            return
          }
          open.add(message.id)
          hub.subscribe(subscriber, message.id, message.name, message.args ?? {})
          return
        }
        case 'unsub':
          open.delete(message.id)
          hub.unsubscribe(subscriber, message.id)
          return
        case 'call': {
          void hub
            .invoke(message.name, message.args ?? {})
            .then((value) => send({ t: 'ack', id: message.id, value: value ?? null }))
            .catch((err: unknown) =>
              send({ t: 'err', id: message.id, message: err instanceof Error ? err.message : String(err) }),
            )
          return
        }
        default:
          ws.close(1008, 'Invalid message')
      }
    })

    ws.on('error', () => {})
    ws.on('close', () => hub.disconnect(subscriber))
  })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === SYNC_PATH) {
      if (!sameOrigin(req.headers.origin, req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      syncSockets.handleUpgrade(req, socket, head, (ws) => syncSockets.emit('connection', ws, req))
      return
    }
    if (relay.handleUpgrade(path, req, socket, head)) return
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only. Reachability comes from Tailscale Serve, so binding
    // 0.0.0.0 would expose the whole app to any local network.
    server.listen(LOCAL_SERVER_PORT, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  // Housekeeping that used to be Convex crons. One timer, since all three jobs
  // are cheap in-process sweeps rather than paginated table scans.
  const reaper = setInterval(
    () => {
      state.reapRuntimeState()
      reapWebhookEvents()
      void reapUploads()
    },
    5 * 60_000,
  )

  running = {
    port: LOCAL_SERVER_PORT,
    hostSecret: relay.hostSecret,
    async close() {
      clearInterval(reaper)
      state.setInvalidator(() => {})
      await relay.close()
      for (const ws of syncSockets.clients) ws.terminate()
      await new Promise<void>((resolve) => syncSockets.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      running = null
    },
  }
  return running
}

export function getLocalServer(): LocalServer | null {
  return running
}

export async function stopLocalServer(): Promise<void> {
  await running?.close()
}

export type { Relay }
