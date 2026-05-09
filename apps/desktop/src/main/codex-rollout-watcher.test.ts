import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
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

  it('treats turn_started / turn_complete as v2 aliases of task_started / task_complete', () => {
    // codex-rs aliases these on the wire (`#[serde(rename = "task_started",
    // alias = "turn_started")]`), so we accept both names.
    const turnStarted = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'turn_started', turn_id: 'abc' },
    })
    expect(parseRolloutLine(turnStarted)).toEqual({ state: 'working', turnId: 'abc' })

    const turnComplete = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'turn_complete', turn_id: 'abc', last_agent_message: 'done' },
    })
    expect(parseRolloutLine(turnComplete)).toEqual({
      state: 'idle',
      turnId: 'abc',
      lastAgentMessage: 'done',
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

  it('getDebugState returns one entry per watched session with the latest state', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, [taskStarted('t1'), taskComplete('t1', 'done')].join('\n') + '\n')
    watcher.watchSession('orch1', file)
    await waitFor(() => received.length >= 1)

    const debug = watcher.getDebugState()
    expect(debug).toHaveLength(1)
    expect(debug[0]).toMatchObject({
      orchestraSessionId: 'orch1',
      transcriptPath: file,
      lastState: 'idle',
      lastTurnId: 't1',
      fileExists: true,
    })
    expect(debug[0].lastEventAt).not.toBeNull()
  })

  it('unwatch removes the entry from getDebugState', async () => {
    const file = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(file, taskStarted('t1') + '\n')
    watcher.watchSession('orch1', file)
    await waitFor(() => received.length >= 1)
    expect(watcher.getDebugState()).toHaveLength(1)

    watcher.unwatchSession('orch1')
    expect(watcher.getDebugState()).toHaveLength(0)
  })
})

describe('CodexRolloutWatcher.discoverAndWatchByCwd', () => {
  let tmpDir: string
  let sessionsRoot: string
  let received: Array<{ sessionId: string; event: CodexRolloutEvent }>
  let watcher: CodexRolloutWatcher

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-discover-'))
    sessionsRoot = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsRoot, { recursive: true })
    received = []
    watcher = new CodexRolloutWatcher({
      onEvent: (sessionId, event) => { received.push({ sessionId, event }) },
      pollIntervalMs: 25,
      sessionsRoot,
    })
  })

  afterEach(() => {
    watcher.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeRolloutFor(date: string, name: string, cwd: string, lines: string[]): string {
    const [y, m, d] = date.split('-')
    const dir = path.join(sessionsRoot, y, m, d)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'codex-uuid', cwd } })
    fs.writeFileSync(file, [meta, ...lines].join('\n') + '\n')
    return file
  }

  it('finds the most recent rollout file matching the cwd and starts watching', async () => {
    const target = writeRolloutFor('2026-05-07', 'rollout-a.jsonl', '/some/cwd', [taskStarted('t1')])

    const ok = watcher.discoverAndWatchByCwd('orch1', '/some/cwd')
    expect(ok).toBe(true)
    await waitFor(() => received.length >= 1)
    expect(received[0]).toMatchObject({ sessionId: 'orch1', event: { state: 'working' } })
    expect(watcher.getDebugState()[0].transcriptPath).toBe(target)
  })

  it('returns false when no rollout matches the cwd', () => {
    writeRolloutFor('2026-05-07', 'rollout-a.jsonl', '/some/other/cwd', [taskStarted('t1')])
    const ok = watcher.discoverAndWatchByCwd('orch1', '/no/match')
    expect(ok).toBe(false)
    expect(received).toEqual([])
  })

  it('skips rollouts already claimed by another orchestra session', async () => {
    const claimed = writeRolloutFor('2026-05-07', 'rollout-a.jsonl', '/cwd', [taskStarted('t1')])
    const newer = writeRolloutFor('2026-05-07', 'rollout-b.jsonl', '/cwd', [taskStarted('t2')])
    // Bump newer's mtime so it's strictly more recent than claimed.
    const now = Date.now() / 1000
    fs.utimesSync(claimed, now - 60, now - 60)
    fs.utimesSync(newer, now, now)

    watcher.watchSession('existing', newer)
    await waitFor(() => received.length >= 1)
    received.length = 0

    const ok = watcher.discoverAndWatchByCwd('orch2', '/cwd')
    expect(ok).toBe(true)
    await waitFor(() => received.length >= 1)
    expect(watcher.getDebugState().find((e) => e.orchestraSessionId === 'orch2')?.transcriptPath)
      .toBe(claimed)
  })

  it('does not re-attach when the orchestra session is already watched', () => {
    const file = writeRolloutFor('2026-05-07', 'rollout-a.jsonl', '/cwd', [taskStarted('t1')])
    watcher.watchSession('orch1', file)
    const ok = watcher.discoverAndWatchByCwd('orch1', '/cwd')
    expect(ok).toBe(false)
  })

  describe('attachByCodexSessionId', () => {
    it('finds the rollout by codex session id suffix in the filename', async () => {
      const target = writeRolloutFor(
        '2026-05-09',
        'rollout-2026-05-09T19-20-49-019e0f0b-2710-76b3-b6b5-13f693135eb0.jsonl',
        '/cwd',
        [taskStarted('t1'), taskComplete('t1', 'done')],
      )
      const ok = watcher.attachByCodexSessionId('orch1', '019e0f0b-2710-76b3-b6b5-13f693135eb0')
      expect(ok).toBe(true)
      await waitFor(() => watcher.getDebugState().length >= 1)
      expect(watcher.getDebugState()[0].transcriptPath).toBe(target)
      expect(watcher.getDebugState()[0].lastState).toBe('idle')
    })

    it('replaces a wrongly-attached file when the hook later supplies the codex session id', async () => {
      // Simulates the bug: cwd-fallback attaches 0ee49fe8 to b041811a's
      // defunct rollout 019e0ee1. Then codex's UserPromptSubmit fires with
      // session_id=019e0f0b. We must swap to 019e0f0b's actual rollout so
      // task_complete events on the right file are seen.
      const wrongFile = writeRolloutFor(
        '2026-05-09',
        'rollout-2026-05-09T18-35-12-019e0ee1-6220-7ee1-a1f4-fe6192b1ef33.jsonl',
        '/cwd',
        [taskStarted('old'), taskComplete('old', 'old done')],
      )
      const correctFile = writeRolloutFor(
        '2026-05-09',
        'rollout-2026-05-09T19-20-49-019e0f0b-2710-76b3-b6b5-13f693135eb0.jsonl',
        '/cwd',
        [taskStarted('fresh')],
      )
      // Wrong attach via cwd-fallback (would happen because 019e0ee1 is the
      // newest unclaimed before 019e0f0b is created in the original race).
      watcher.watchSession('orch1', wrongFile)
      await waitFor(() => received.length >= 1)
      received.length = 0

      // Hook fires with the authoritative codex session id.
      const ok = watcher.attachByCodexSessionId('orch1', '019e0f0b-2710-76b3-b6b5-13f693135eb0')
      expect(ok).toBe(true)
      await waitFor(() => received.length >= 1)
      expect(watcher.getDebugState()[0].transcriptPath).toBe(correctFile)
      expect(received[received.length - 1].event.state).toBe('working')
    })

    it('returns false when no rollout matches the codex session id', () => {
      writeRolloutFor('2026-05-09', 'rollout-2026-05-09T19-20-49-other.jsonl', '/cwd', [])
      const ok = watcher.attachByCodexSessionId('orch1', '019eXXXX-aaaa-bbbb-cccc-dddddddddddd')
      expect(ok).toBe(false)
    })
  })

  it('keeps polling past the fast-phase budget when the rollout materializes late', async () => {
    // codex CLI sometimes takes 30-60s after process detection before it
    // finishes writing session_meta to the rollout file (observed live: 60s
    // gap on a heavily-loaded machine where dev servers were saturating I/O).
    // The retry schedule must keep polling past the fast burst.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      watcher.scheduleDiscovery('orch-late', '/cwd-late')
      // Burn through the entire fast phase (500+1000+2000+4000+8000 = 15500ms).
      // No file yet — every attempt fails.
      await vi.advanceTimersByTimeAsync(16_000)
      expect(watcher.getDebugState()).toHaveLength(0)

      // Drop in the rollout. The slow-phase poll (30s) should fire next.
      writeRolloutFor('2026-05-09', 'rollout-late.jsonl', '/cwd-late', [taskStarted('t1')])
      await vi.advanceTimersByTimeAsync(31_000)

      expect(watcher.getDebugState()).toHaveLength(1)
      expect(watcher.getDebugState()[0].lastState).toBe('working')
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches session_meta when the first line is >8KB (codex embeds the full system prompt)', async () => {
    // Production rollouts have first lines around 20-30KB because codex puts
    // its entire base_instructions block inside session_meta.payload. The
    // earlier 8KB read truncated the JSON and parsing always failed, which
    // made discovery silently return null on every real rollout.
    const dir = path.join(sessionsRoot, '2026', '05', '07')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rollout-bloat.jsonl')
    const baseInstructions = 'X'.repeat(25_000)
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-uuid', cwd: '/cwd', base_instructions: { text: baseInstructions } },
    })
    fs.writeFileSync(file, meta + '\n' + taskStarted('t1') + '\n')

    const ok = watcher.discoverAndWatchByCwd('orch1', '/cwd')
    expect(ok).toBe(true)
    await waitFor(() => received.length >= 1)
    expect(received[0].event.state).toBe('working')
  })

  it('scheduleDiscovery retries until the rollout file appears', async () => {
    // Codex CLI creates the rollout file a few seconds after the process is
    // detectable — this races with our discovery and was the v1.11.1 stuck-
    // working bug. Simulate the race: schedule discovery first, then write
    // the file ~120ms later. The retry schedule's first delay is 500ms so
    // the second attempt picks it up.
    watcher.scheduleDiscovery('orch1', '/cwd')
    expect(watcher.getDebugState()).toHaveLength(0)

    await new Promise((r) => setTimeout(r, 120))
    writeRolloutFor('2026-05-07', 'rollout-late.jsonl', '/cwd', [taskStarted('t1')])

    await waitFor(() => watcher.getDebugState().length >= 1, 3000)
    expect(watcher.getDebugState()[0].lastState).toBe('working')
  })

  it('scheduleDiscovery is canceled when watchSession attaches via the hook path first', async () => {
    // When the codex hook delivers a transcript_path before the cwd-based
    // retry fires, watchSession claims the session and the pending
    // discovery should stop trying.
    const exact = writeRolloutFor('2026-05-07', 'rollout-exact.jsonl', '/cwd', [taskStarted('t1')])
    watcher.scheduleDiscovery('orch1', '/cwd')

    // Hook arrives during the retry window with the authoritative path.
    watcher.watchSession('orch1', exact)
    await waitFor(() => received.length >= 1)

    // Drop a second rollout that also matches the cwd. If discovery were
    // still running, it would attach this one and override the hook-supplied
    // path. The cancel must hold.
    await new Promise((r) => setTimeout(r, 50))
    writeRolloutFor('2026-05-07', 'rollout-late.jsonl', '/cwd', [taskStarted('t2')])
    await new Promise((r) => setTimeout(r, 1500))

    expect(watcher.getDebugState()).toHaveLength(1)
    expect(watcher.getDebugState()[0].transcriptPath).toBe(exact)
  })
})
