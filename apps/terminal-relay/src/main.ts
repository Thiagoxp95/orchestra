import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { createRelay } from './relay.js'

const secret = process.env.DEVICE_SECRET ?? ''
const convex = new ConvexHttpClient(process.env.CONVEX_URL ?? 'https://orchestra-convex.fly.dev')
const origins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)
if (!origins.length) throw new Error('ALLOWED_ORIGINS is required')
const relay = createRelay({
  secret, origins,
  async authorize(token, sessionId) {
    await convex.query(makeFunctionReference<'query'>('terminalStream:authorize'), { secret, token, sessionId })
  },
})
relay.server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('Terminal relay listening'))
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void relay.close().then(() => process.exit(0)))
