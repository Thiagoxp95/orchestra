import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { buildCursorNotifyScript } from './cursor-notify-script'
import { buildCursorHooksJsonContent, ensureCursorHooksRegistered } from './cursor-hooks-setup'
import { CursorNotifyListener, parseCursorHookBody } from './cursor-notify-listener'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

const NOTIFY = '/tmp/orch-test-cursor-notify.sh'

function collect() {
  const updates: { status: NormalizedAgentSessionStatus; aborted: boolean }[] = []
  const listener = new CursorNotifyListener({
    onStatusUpdate: (status, meta) => updates.push({ status, aborted: meta.aborted }),
  })
  return { listener, updates, states: () => updates.map((u) => u.status.state) }
}

describe('CursorNotifyListener', () => {
  it('maps a prompt to working and the turn stop to idle, tagged as cursor', () => {
    const { listener, updates, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'sessionStart' })
    listener.ingest({ sessionId: 's1', event: 'beforeSubmitPrompt' })
    listener.ingest({ sessionId: 's1', event: 'stop', status: 'completed' })
    expect(states()).toEqual(['idle', 'working', 'idle'])
    expect(updates.every((u) => u.status.agent === 'cursor' && u.status.authority === 'cursor-hook')).toBe(true)
    expect(updates[2].aborted).toBe(false)
  })

  it('flags an interrupted turn so no Finished notification fires', () => {
    const { listener, updates } = collect()
    listener.ingest({ sessionId: 's1', event: 'beforeSubmitPrompt' })
    listener.ingest({ sessionId: 's1', event: 'stop', status: 'aborted' })
    expect(updates[1].aborted).toBe(true)
  })

  it('does not let a tool event that lands after stop re-latch working', () => {
    const { listener, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'beforeSubmitPrompt' })
    listener.ingest({ sessionId: 's1', event: 'stop', status: 'completed' })
    listener.ingest({ sessionId: 's1', event: 'postToolUse' })
    expect(states()).toEqual(['working', 'idle'])
    expect(listener.getLatest('s1')?.state).toBe('idle')
  })

  it('restores working from a tool event when the pane has no recorded state', () => {
    const { listener, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'preToolUse' })
    expect(states()).toEqual(['working'])
  })

  it('sessionStart never ends a turn already in flight', () => {
    const { listener, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'beforeSubmitPrompt' })
    listener.ingest({ sessionId: 's1', event: 'sessionStart' })
    expect(states()).toEqual(['working'])
  })

  it('rejects malformed and unknown bodies', () => {
    expect(parseCursorHookBody('nope')).toBeNull()
    expect(parseCursorHookBody('{"sessionId":"s1","event":"afterAgentThought"}')).toBeNull()
    expect(parseCursorHookBody('{"sessionId":"","event":"stop"}')).toBeNull()
    expect(parseCursorHookBody('{"sessionId":"s1","event":"stop","status":"aborted","conversationId":""}'))
      .toEqual({ sessionId: 's1', event: 'stop', status: 'aborted' })
  })
})

describe('buildCursorHooksJsonContent', () => {
  it('returns null for an unparseable file', () => {
    expect(buildCursorHooksJsonContent(null, NOTIFY)).toBeNull()
  })

  it('keeps other tools’ hooks, adds flat managed entries, and is idempotent', () => {
    const existing = {
      version: 1,
      hooks: { stop: [{ command: '/other/tool.sh', timeout: 10 }], afterFileEdit: [{ command: '/fmt.sh' }] },
    }
    const once = buildCursorHooksJsonContent(existing, NOTIFY)!
    const parsed = JSON.parse(once)
    expect(parsed.version).toBe(1)
    expect(parsed.hooks.stop).toEqual([{ command: '/other/tool.sh', timeout: 10 }, { command: NOTIFY, timeout: 5 }])
    expect(parsed.hooks.afterFileEdit).toEqual([{ command: '/fmt.sh' }])
    expect(parsed.hooks.beforeSubmitPrompt).toEqual([{ command: NOTIFY, timeout: 5 }])
    expect(buildCursorHooksJsonContent(parsed, NOTIFY)).toBe(once)
  })

  it('refuses to overwrite an unparseable hooks.json on disk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cursor-home-'))
    try {
      fs.mkdirSync(path.join(home, '.cursor'))
      fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), '{ broken')
      const result = ensureCursorHooksRegistered({ home, env: { HOME: home } })
      expect(result).toBeNull()
      expect(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')).toBe('{ broken')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('cursor-notify.sh', () => {
  function writeScript(): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cursor-script-'))
    const hooks = path.join(dir, 'hooks')
    fs.mkdirSync(hooks)
    const file = path.join(hooks, 'cursor-notify.sh')
    fs.writeFileSync(file, buildCursorNotifyScript(), { mode: 0o755 })
    return { dir, file }
  }

  it('passes bash -n and always answers cursor with {} even outside orchestra', () => {
    const { dir, file } = writeScript()
    try {
      execFileSync('bash', ['-n', file])
      const run = spawnSync('bash', [file], { input: '{"hook_event_name":"stop"}', env: {} })
      expect(run.stdout.toString()).toBe('{}\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('posts the event, stop status and conversation id to the port file’s listener', async () => {
    const { dir, file } = writeScript()
    let received = ''
    const server = http.createServer((req, res) => {
      req.on('data', (c) => { received += c })
      req.on('end', () => { res.statusCode = 204; res.end() })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      fs.writeFileSync(path.join(dir, 'cursor-hook-port'), String(port))
      const payload = JSON.stringify({
        conversation_id: '2f72c3b3-c3d6-4d0f-a44b-d337190472ed',
        status: 'aborted',
        hook_event_name: 'stop',
      })
      await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', [file], {
          env: { PATH: process.env.PATH, ORCHESTRA_CURSOR_SESSION_ID: 'pane-1' },
        })
        let out = ''
        child.stdout.on('data', (c: Buffer) => { out += c })
        child.on('exit', () => (out === '{}\n' ? resolve() : reject(new Error(`stdout ${out}`))))
        child.stdin.end(payload)
      })
      expect(JSON.parse(received)).toEqual({
        sessionId: 'pane-1',
        event: 'stop',
        status: 'aborted',
        conversationId: '2f72c3b3-c3d6-4d0f-a44b-d337190472ed',
      })
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
