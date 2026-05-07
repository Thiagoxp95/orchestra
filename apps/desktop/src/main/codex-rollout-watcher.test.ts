import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  CodexRolloutWatcher,
  parseRolloutLine,
  type CodexRolloutEvent,
} from './codex-rollout-watcher'

const taskStarted = (turnId: string) => JSON.stringify({
  timestamp: '2026-05-07T15:21:57.739Z',
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId, started_at: 1, model_context_window: 1, collaboration_mode_kind: 'default' },
})

const taskComplete = (turnId: string, message: string) => JSON.stringify({
  timestamp: '2026-05-07T15:25:46.600Z',
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message, completed_at: 2, duration_ms: 1, time_to_first_token_ms: 1 },
})

const turnAborted = (turnId: string) => JSON.stringify({
  timestamp: '2026-05-07T15:21:58.000Z',
  type: 'event_msg',
  payload: { type: 'turn_aborted', turn_id: turnId },
})

describe('parseRolloutLine', () => {
  it('returns null for malformed JSON', () => {
    expect(parseRolloutLine('not json')).toBeNull()
    expect(parseRolloutLine('')).toBeNull()
    expect(parseRolloutLine('{')).toBeNull()
  })

  it('returns null for session_meta and response_item lines', () => {
    expect(parseRolloutLine(JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }))).toBeNull()
    expect(parseRolloutLine(JSON.stringify({ type: 'response_item', payload: { type: 'message' } }))).toBeNull()
  })

  it('returns null for event_msg types we do not consume', () => {
    expect(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }))).toBeNull()
    expect(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }))).toBeNull()
    expect(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'exec_command_end' } }))).toBeNull()
  })

  it('parses task_started as working with the turn id', () => {
    expect(parseRolloutLine(taskStarted('abc'))).toEqual({
      state: 'working',
      turnId: 'abc',
    })
  })

  it('parses task_complete as idle with the agent message', () => {
    expect(parseRolloutLine(taskComplete('abc', 'done'))).toEqual({
      state: 'idle',
      turnId: 'abc',
      lastAgentMessage: 'done',
    })
  })

  it('parses task_complete with empty last_agent_message as idle without message', () => {
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'abc' } })
    expect(parseRolloutLine(line)).toEqual({
      state: 'idle',
      turnId: 'abc',
    })
  })

  it('parses turn_aborted as idle with aborted flag', () => {
    expect(parseRolloutLine(turnAborted('abc'))).toEqual({
      state: 'idle',
      turnId: 'abc',
      aborted: true,
    })
  })

  it('parses error/stream_error event_msg types as idle with error flag', () => {
    expect(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: 'rate limit' } }))).toEqual({
      state: 'idle',
      error: 'rate limit',
    })
    expect(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'stream_error', message: 'disconnect' } }))).toEqual({
      state: 'idle',
      error: 'disconnect',
    })
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!predicate()) throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate`)
}

describe('CodexRolloutWatcher', () => {
  let tmpDir: string
  let received: Array<{ sessionId: string; event: CodexRolloutEvent }>
  let watcher: CodexRolloutWatcher

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-watcher-'))
    received = []
    watcher = new CodexRolloutWatcher({
      onEvent: (sessionId, event) => { received.push({ sessionId, event }) },
      // Tight poll interval for fast tests; production uses the default.
      pollIntervalMs: 25,
    })
  })

  afterEach(() => {
    watcher.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits the latest state when attaching to a file already at idle', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, [taskStarted('t1'), taskComplete('t1', 'first')].join('\n') + '\n')

    watcher.watchSession('orch1', file)
    await waitFor(() => received.length >= 1)

    // Only the most recent relevant event is replayed at attach — the consumer
    // should learn the current state without re-living history.
    expect(received).toEqual([
      { sessionId: 'orch1', event: { state: 'idle', turnId: 't1', lastAgentMessage: 'first' } },
    ])
  })

  it('emits the latest state when attaching to a file mid-turn (working)', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, [
      taskStarted('t1'),
      taskComplete('t1', 'first'),
      taskStarted('t2'),
    ].join('\n') + '\n')

    watcher.watchSession('orch1', file)
    await waitFor(() => received.length >= 1)

    expect(received).toEqual([
      { sessionId: 'orch1', event: { state: 'working', turnId: 't2' } },
    ])
  })

  it('emits incremental events as the file grows', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, '')
    watcher.watchSession('orch1', file)
    // Settle so the watcher's initial scan sees an empty file before we append.
    await new Promise((r) => setTimeout(r, 60))

    fs.appendFileSync(file, taskStarted('t1') + '\n')
    await waitFor(() => received.length >= 1)
    expect(received[0].event.state).toBe('working')

    fs.appendFileSync(file, taskComplete('t1', 'done') + '\n')
    await waitFor(() => received.length >= 2)
    expect(received[1].event).toEqual({ state: 'idle', turnId: 't1', lastAgentMessage: 'done' })
  })

  it('waits for the file to appear before emitting', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    watcher.watchSession('orch1', file)
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toEqual([])

    fs.writeFileSync(file, taskStarted('t1') + '\n')
    await waitFor(() => received.length >= 1)
    expect(received[0].event.state).toBe('working')
  })

  it('buffers partial line writes and parses once a newline arrives', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, '')
    watcher.watchSession('orch1', file)
    await new Promise((r) => setTimeout(r, 60))

    const line = taskStarted('t1')
    fs.appendFileSync(file, line.slice(0, 25))
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toEqual([])

    fs.appendFileSync(file, line.slice(25) + '\n')
    await waitFor(() => received.length >= 1)
    expect(received[0].event.state).toBe('working')
  })

  it('unwatchSession stops further events for that session', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, '')
    watcher.watchSession('orch1', file)
    await new Promise((r) => setTimeout(r, 60))

    watcher.unwatchSession('orch1')

    fs.appendFileSync(file, taskStarted('t1') + '\n')
    await new Promise((r) => setTimeout(r, 120))
    expect(received).toEqual([])
  })

  it('isolates sessions — events for one do not leak to another', async () => {
    const fileA = path.join(tmpDir, 'a.jsonl')
    const fileB = path.join(tmpDir, 'b.jsonl')
    fs.writeFileSync(fileA, '')
    fs.writeFileSync(fileB, '')
    watcher.watchSession('A', fileA)
    watcher.watchSession('B', fileB)
    await new Promise((r) => setTimeout(r, 60))

    fs.appendFileSync(fileA, taskStarted('tA') + '\n')
    await waitFor(() => received.length >= 1)

    expect(received).toEqual([
      { sessionId: 'A', event: { state: 'working', turnId: 'tA' } },
    ])
  })

  it('skips event_msg types it does not consume even when they appear mid-stream', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, '')
    watcher.watchSession('orch1', file)
    await new Promise((r) => setTimeout(r, 60))

    const tokenCount = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })
    fs.appendFileSync(file, [tokenCount, taskStarted('t1'), tokenCount, tokenCount].join('\n') + '\n')
    await waitFor(() => received.length >= 1)

    expect(received).toHaveLength(1)
    expect(received[0].event.state).toBe('working')
  })

  it('survives a malformed line without breaking subsequent parsing', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, '')
    watcher.watchSession('orch1', file)
    await new Promise((r) => setTimeout(r, 60))

    fs.appendFileSync(file, '{not-json\n' + taskStarted('t1') + '\n')
    await waitFor(() => received.length >= 1)

    expect(received[0].event.state).toBe('working')
  })
})
