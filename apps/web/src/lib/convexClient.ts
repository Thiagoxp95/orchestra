import { ConvexReactClient } from 'convex/react'

export const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL as string

let client: ConvexReactClient | null = null
let socket: WebSocket | null = null
let lastRecovery = -Infinity

/** Keep the Convex client (queries and pending mutations), replace only transport. */
export function reconnectConvexTransport(): void {
  if (Date.now() - lastRecovery < 1000) return
  lastRecovery = Date.now()
  const ws = socket
  if (!ws) return
  socket = null
  const onclose = ws.onclose
  // A dead mobile network can stall close() too. Retire the native handlers and
  // notify Convex now; its normal reconnect protocol preserves request identity.
  ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null
  ws.close()
  onclose?.call(ws, new CloseEvent('close', { code: 1000, reason: 'Foreground recovery' }))
}

export function getConvexClient(): ConvexReactClient {
  if (!client) {
    const webSocketConstructor = typeof WebSocket === 'undefined' ? undefined : class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        socket = this
        this.addEventListener('close', () => { if (socket === this) socket = null })
      }
      close(code?: number, reason?: string) {
        if (socket === this) socket = null
        super.close(code, reason)
      }
    }
    client = new ConvexReactClient(CONVEX_URL, { webSocketConstructor })
  }
  return client
}
