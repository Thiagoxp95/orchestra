import { describe, it, expect, afterEach } from 'vitest'
import { createHookServer, type HookQuery, type HookServer } from './hook-server'

describe('hook-server', () => {
  let server: HookServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('starts on an ephemeral 127.0.0.1 port and exposes it', async () => {
    server = await createHookServer()
    expect(server.port).toBeGreaterThan(0)
    expect(server.host).toBe('127.0.0.1')
  })

  it('dispatches GET requests to registered route handlers with parsed query', async () => {
    server = await createHookServer()
    const received: Array<Record<string, string>> = []
    server.registerGetRoute('/test/hook', async (query: HookQuery) => {
      received.push({ ...query })
      return { status: 204 }
    })

    const res = await fetch(`http://127.0.0.1:${server.port}/test/hook?sessionId=abc&eventType=Start`)
    expect(res.status).toBe(204)
    expect(received).toEqual([{ sessionId: 'abc', eventType: 'Start' }])
  })

  it('returns 404 for unregistered routes', async () => {
    server = await createHookServer()
    const res = await fetch(`http://127.0.0.1:${server.port}/unknown`)
    expect(res.status).toBe(404)
  })

  it('returns 405 for non-GET methods', async () => {
    server = await createHookServer()
    server.registerGetRoute('/only-get', async () => ({ status: 204 }))
    const res = await fetch(`http://127.0.0.1:${server.port}/only-get`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
