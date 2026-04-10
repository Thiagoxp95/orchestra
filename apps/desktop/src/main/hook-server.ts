// Tiny HTTP server bound to 127.0.0.1 for receiving hook events from
// external helper scripts (claude-notify.sh, codex-notify.sh, …).
//
// Design constraints:
//   - Bind to 127.0.0.1 ONLY. Never publicly accessible.
//   - Ephemeral port chosen by the OS; the port is written to a file
//     the daemon reads at terminal spawn time.
//   - GET-only — matches `curl -G --data-urlencode` in the helper scripts
//     and keeps the handler synchronous-ish.

import * as http from 'node:http'

export type HookQuery = Record<string, string>

export interface HookResponse {
  status: number
  body?: string
}

export type HookGetHandler = (query: HookQuery) => Promise<HookResponse> | HookResponse

export interface HookServer {
  readonly host: string
  readonly port: number
  registerGetRoute(path: string, handler: HookGetHandler): void
  stop(): Promise<void>
}

const HOST = '127.0.0.1'

export async function createHookServer(): Promise<HookServer> {
  const routes = new Map<string, HookGetHandler>()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}`)
      const handler = routes.get(url.pathname)
      if (!handler) {
        res.statusCode = 404
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end()
        return
      }

      const query: HookQuery = {}
      url.searchParams.forEach((value, key) => { query[key] = value })

      const result = await handler(query)
      res.statusCode = result.status
      if (result.body !== undefined) {
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(result.body)
      } else {
        res.end()
      }
    } catch (err) {
      console.error('[hook-server] handler error', err)
      res.statusCode = 500
      res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('[hook-server] failed to acquire listening address')
  }

  return {
    host: HOST,
    port: address.port,
    registerGetRoute(path, handler) {
      routes.set(path, handler)
    },
    stop() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
