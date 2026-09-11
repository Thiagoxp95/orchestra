import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonLineRpcTransport } from './codex-rpc'

function harness(timeoutMs = 100) {
  const input = new PassThrough()
  const output = new PassThrough()
  const writes: Record<string, unknown>[] = []
  let buffered = ''
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    writes.push(...lines.filter(Boolean).map((line) => JSON.parse(line)))
  })
  return { input, output, writes, rpc: new JsonLineRpcTransport(input, output, timeoutMs) }
}

describe('JsonLineRpcTransport', () => {
  it('resolves a request from the matching JSON-RPC response', async () => {
    const { input, writes, rpc } = harness()
    const result = rpc.request('model/list', {})
    expect(writes).toEqual([{ id: 1, method: 'model/list', params: {} }])
    input.write(`${JSON.stringify({ id: 1, result: { data: [] } })}\n`)
    await expect(result).resolves.toEqual({ data: [] })
  })

  it('answers server requests and forwards notifications', async () => {
    const { input, writes, rpc } = harness()
    const notifications: string[] = []
    rpc.onNotification((method) => notifications.push(method))
    rpc.onRequest(async (method, params) => ({ method, params }))

    input.write(`${JSON.stringify({ method: 'turn/started', params: { turn: { id: 't1' } } })}\n`)
    input.write(`${JSON.stringify({ id: 'approval-1', method: 'approve', params: { command: 'ls' } })}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    expect(notifications).toEqual(['turn/started'])
    expect(writes).toEqual([{ id: 'approval-1', result: { method: 'approve', params: { command: 'ls' } } }])
  })

  it('rejects pending operations on timeout and disconnect', async () => {
    const timed = harness(5)
    await expect(timed.rpc.request('never', {})).rejects.toThrow(/timed out/i)

    const closed = harness()
    const pending = closed.rpc.request('pending', {})
    closed.input.destroy(new Error('pipe broke'))
    await expect(pending).rejects.toThrow(/pipe broke|disconnected/i)
  })
})
