import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { buildAntigravityNotifyScript } from './antigravity-notify-script'
import {
  buildAntigravityHooksJsonContent,
  ensureAntigravityHooksRegistered,
} from './antigravity-hooks-setup'
import {
  AntigravityNotifyListener,
  parseAntigravityHookBody,
} from './antigravity-notify-listener'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

const NOTIFY = '/tmp/orch-test-antigravity-notify.sh'

function collect() {
  const updates: { status: NormalizedAgentSessionStatus; aborted: boolean }[] = []
  const conversations: { sessionId: string; conversationId: string }[] = []
  const listener = new AntigravityNotifyListener({
    onStatusUpdate: (status, meta) => updates.push({ status, aborted: meta.aborted }),
    onConversationId: (sessionId, conversationId) => conversations.push({ sessionId, conversationId }),
  })
  return { listener, updates, conversations, states: () => updates.map((u) => u.status.state) }
}

describe('AntigravityNotifyListener', () => {
  it('maps PreInvocation to working, ask_question to waitingUserInput, PostToolUse to working, and Stop to idle', () => {
    const { listener, updates, conversations, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'SessionStart', conversationId: 'conv-1' })
    listener.ingest({ sessionId: 's1', event: 'PreInvocation' })
    listener.ingest({ sessionId: 's1', event: 'PreToolUse', toolName: 'ask_question' })
    listener.ingest({ sessionId: 's1', event: 'PostToolUse', toolName: 'ask_question' })
    listener.ingest({ sessionId: 's1', event: 'Stop', terminationReason: 'NO_TOOL_CALL' })

    expect(states()).toEqual(['idle', 'working', 'waitingUserInput', 'working', 'idle'])
    expect(updates.every((u) => u.status.agent === 'antigravity' && u.status.authority === 'antigravity-hook')).toBe(true)
    expect(updates[4].aborted).toBe(false)
    expect(conversations).toEqual([{ sessionId: 's1', conversationId: 'conv-1' }])
  })

  it('flags a USER_CANCELED stop as aborted so no Finished notification fires', () => {
    const { listener, updates } = collect()
    listener.ingest({ sessionId: 's1', event: 'PreInvocation' })
    listener.ingest({ sessionId: 's1', event: 'Stop', terminationReason: 'USER_CANCELED' })
    expect(updates[1].aborted).toBe(true)
  })

  it('does not let a late PostToolUse after Stop re-latch working', () => {
    const { listener, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'PreInvocation' })
    listener.ingest({ sessionId: 's1', event: 'Stop', terminationReason: 'NO_TOOL_CALL' })
    listener.ingest({ sessionId: 's1', event: 'PostToolUse', toolName: 'run_command' })
    expect(states()).toEqual(['working', 'idle'])
    expect(listener.getLatest('s1')?.state).toBe('idle')
  })

  it('restores working from PostToolUse when the pane has no recorded state', () => {
    const { listener, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'PostToolUse', toolName: 'read_file' })
    expect(states()).toEqual(['working'])
  })

  it('SessionStart never ends a turn already in flight', () => {
    const { listener, states } = collect()
    listener.ingest({ sessionId: 's1', event: 'PreInvocation' })
    listener.ingest({ sessionId: 's1', event: 'SessionStart' })
    expect(states()).toEqual(['working'])
  })

  it('rejects malformed and unknown bodies', () => {
    expect(parseAntigravityHookBody('nope')).toBeNull()
    expect(parseAntigravityHookBody('{"sessionId":"s1","event":"UnknownEvent"}')).toBeNull()
    expect(parseAntigravityHookBody('{"sessionId":"","event":"Stop"}')).toBeNull()
    expect(
      parseAntigravityHookBody(
        '{"sessionId":"s1","event":"Stop","terminationReason":"USER_CANCELED","conversationId":"","toolName":""}',
      ),
    ).toEqual({ sessionId: 's1', event: 'Stop', terminationReason: 'USER_CANCELED' })
  })
})

describe('buildAntigravityHooksJsonContent', () => {
  it('returns null for an unparseable file', () => {
    expect(buildAntigravityHooksJsonContent(null, NOTIFY)).toBeNull()
  })

  it('preserves other named hooks, writes orchestra-notify, and is idempotent', () => {
    const existing = {
      'user-linter': {
        PostToolUse: [{ matcher: 'edit_file', hooks: [{ type: 'command', command: './lint.sh' }] }],
      },
    }
    const once = buildAntigravityHooksJsonContent(existing, NOTIFY, 'orchestra-notify')!
    const parsed = JSON.parse(once)
    expect(parsed['user-linter']).toEqual(existing['user-linter'])
    expect(parsed['orchestra-notify'].PreInvocation).toEqual([
      { type: 'command', command: NOTIFY, timeout: 5 },
    ])
    expect(parsed['orchestra-notify'].PreToolUse).toEqual([
      { matcher: 'ask_question', hooks: [{ type: 'command', command: NOTIFY, timeout: 5 }] },
    ])
    expect(parsed['orchestra-notify'].Stop).toEqual([
      { type: 'command', command: NOTIFY, timeout: 5 },
    ])
    expect(buildAntigravityHooksJsonContent(parsed, NOTIFY, 'orchestra-notify')).toBe(once)
  })

  it('refuses to overwrite an unparseable hooks.json on disk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agy-home-'))
    try {
      fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true })
      fs.writeFileSync(path.join(home, '.gemini', 'config', 'hooks.json'), '{ broken')
      const result = ensureAntigravityHooksRegistered({ home, env: { HOME: home } })
      expect(result).toBeNull()
      expect(fs.readFileSync(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8')).toBe('{ broken')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('antigravity-notify.sh', () => {
  function writeScript(): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agy-script-'))
    const hooks = path.join(dir, 'hooks')
    fs.mkdirSync(hooks)
    const file = path.join(hooks, 'antigravity-notify.sh')
    fs.writeFileSync(file, buildAntigravityNotifyScript(), { mode: 0o755 })
    return { dir, file }
  }

  it('passes bash -n and always outputs {} even outside orchestra', () => {
    const { dir, file } = writeScript()
    try {
      execFileSync('bash', ['-n', file])
      const run = spawnSync('bash', [file], { input: '{"hookEventName":"Stop"}', env: {} })
      expect(run.stdout.toString()).toBe('{}\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('posts camelCase hook fields to the port file listener', async () => {
    const { dir, file } = writeScript()
    let received = ''
    const server = http.createServer((req, res) => {
      req.on('data', (c) => { received += c })
      req.on('end', () => { res.statusCode = 204; res.end() })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      fs.writeFileSync(path.join(dir, 'antigravity-hook-port'), String(port))
      const payload = JSON.stringify({
        conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
        hookEventName: 'PreToolUse',
        toolCall: { id: 't1', name: 'ask_question', args: {} },
      })
      await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', [file], {
          env: { PATH: process.env.PATH, ORCHESTRA_ANTIGRAVITY_SESSION_ID: 'pane-agy-1' },
        })
        let out = ''
        child.stdout.on('data', (c: Buffer) => { out += c })
        child.on('exit', () => (out === '{}\n' ? resolve() : reject(new Error(`stdout ${out}`))))
        child.stdin.end(payload)
      })
      expect(JSON.parse(received)).toEqual({
        sessionId: 'pane-agy-1',
        event: 'PreToolUse',
        terminationReason: '',
        conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
        toolName: 'ask_question',
      })
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
