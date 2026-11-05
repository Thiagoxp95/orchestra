import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createStaticHandler } from './static-files'

const bundle = 'console.log("orchestra");\n'.repeat(2000)
let root: string
let server: Server

function get(path: string, acceptEncoding?: string): Promise<{ headers: Record<string, unknown>; body: Buffer }> {
  const { port } = server.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = request({ port, path, headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'static-'))
  mkdirSync(join(root, '_next/static'), { recursive: true })
  writeFileSync(join(root, '_next/static/app.js'), bundle)
  writeFileSync(join(root, 'icon.png'), Buffer.alloc(64, 1))
  const handle = createStaticHandler(root)
  server = createServer((req, res) => void handle(req, res, req.url ?? '/'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('static files', () => {
  it('gzips the bundle for a phone that accepts it', async () => {
    const res = await get('/_next/static/app.js', 'gzip, deflate, br')
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.body.length).toBeLessThan(bundle.length / 10)
    expect(gunzipSync(res.body).toString()).toBe(bundle)
  })

  it('sends it as-is to a client that does not', async () => {
    const res = await get('/_next/static/app.js')
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.toString()).toBe(bundle)
  })

  it('leaves already-compressed images alone', async () => {
    const res = await get('/icon.png', 'gzip')
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.length).toBe(64)
  })
})
