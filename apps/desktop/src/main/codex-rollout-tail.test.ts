// apps/desktop/src/main/codex-rollout-tail.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { watchCodexRollout, stopAllCodexRolloutWatchers } from './codex-rollout-tail'
import { __resetForTests, getLastUserMessage } from './last-user-message-store'
import type { NormalizedAgentSessionStatus } from '../shared/agent-session-types'

describe('watchCodexRollout', () => {
  let tmpRoot: string
  let cwd: string
  let rolloutRoot: string

  beforeEach(() => {
    __resetForTests()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-'))
    cwd = path.join(tmpRoot, 'project')
    fs.mkdirSync(cwd, { recursive: true })
    rolloutRoot = path.join(tmpRoot, 'sessions')
    fs.mkdirSync(rolloutRoot, { recursive: true })
  })

  afterEach(() => {
    stopAllCodexRolloutWatchers()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  /**
   * Build a minimal JSONL rollout file that `findCodexRolloutByDirectory` can
   * locate (first line = session meta with payload.id + payload.cwd +
   * payload.timestamp) and that `parseCodexRolloutLines` will map to
   * lastUserPrompt (response_item with role=user and content[].text).
   */
  function makeRollout(threadId: string, userText: string): string {
    const headerTimestamp = new Date().toISOString()
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, cwd, timestamp: headerTimestamp },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: userText }],
        },
      }),
    ].join('\n') + '\n'
    const file = path.join(rolloutRoot, `${threadId}.jsonl`)
    fs.writeFileSync(file, lines)
    return file
  }

  it('picks up last user prompt from an existing rollout file', async () => {
    const sessionCreatedAt = Date.now()
    makeRollout('t1', 'hello codex')
    watchCodexRollout('s1', cwd, sessionCreatedAt, { rolloutRoot })
    // Discovery poll runs at 1s interval; first read happens after it finds the file.
    await new Promise((r) => setTimeout(r, 1300))
    expect(getLastUserMessage('s1')?.text).toBe('hello codex')
  })

  it('emits working → idle transitions derived from the rollout file', async () => {
    const sessionCreatedAt = Date.now()
    const threadId = 't-status'
    const headerTimestamp = new Date().toISOString()
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd, timestamp: headerTimestamp } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ].join('\n') + '\n'
    const file = path.join(rolloutRoot, `${threadId}.jsonl`)
    fs.writeFileSync(file, lines)

    const updates: NormalizedAgentSessionStatus[] = []
    watchCodexRollout('s-status', cwd, sessionCreatedAt, {
      rolloutRoot,
      onStatusUpdate: (status) => { updates.push(status) },
    })

    await new Promise((r) => setTimeout(r, 1300))
    expect(updates.at(-1)?.state).toBe('working')
    expect(updates.at(-1)?.authority).toBe('codex-watcher-fallback')
    expect(updates.at(-1)?.connected).toBe(true)

    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 800))
    expect(updates.at(-1)?.state).toBe('idle')
    expect(updates.filter((u) => u.state === 'working')).toHaveLength(1)
    expect(updates.filter((u) => u.state === 'idle')).toHaveLength(1)
  })

  it('updates when a new user prompt is appended', async () => {
    const sessionCreatedAt = Date.now()
    const file = makeRollout('t1', 'first prompt')
    watchCodexRollout('s1', cwd, sessionCreatedAt, { rolloutRoot })
    await new Promise((r) => setTimeout(r, 1300))
    expect(getLastUserMessage('s1')?.text).toBe('first prompt')

    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'second prompt' }],
        },
      }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 800))
    expect(getLastUserMessage('s1')?.text).toBe('second prompt')
  })
})
