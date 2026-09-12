import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { createRelay } from './relay.js'
import { relayConfig } from './config.js'

const secret = process.env.DEVICE_SECRET ?? process.env.MAIN_VITE_DEVICE_SECRET ?? ''
const convex = new ConvexHttpClient(process.env.CONVEX_URL ?? 'http://127.0.0.1:13210')
const { host, port, origins } = relayConfig(process.env)
const relay = createRelay({
  secret, origins,
  async authorize(token, sessionId) {
    await convex.query(makeFunctionReference<'query'>('terminalStream:authorize'), { secret, token, sessionId })
  },
})
relay.server.listen(port, host, () => console.log(`Private terminal relay listening on ${host}:${port}`))
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void relay.close().then(() => process.exit(0)))
