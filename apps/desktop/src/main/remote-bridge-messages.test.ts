import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { AgentMessageMirror, type OutgoingChatMessage } from './remote-bridge-messages'
import { claudeProjectDir } from './agent-context'

const CLAUDE_TS = '2026-07-27T12:00:00.000Z'

const claudeUser = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: CLAUDE_TS,
    sessionId: 'claude-sess',
    message: { role: 'user', content: text },
  })

const codexMeta = (): string =>
  JSON.stringify({ timestamp: CLAUDE_TS, type: 'session_meta', payload: { id: 'codex-sess', cwd: '/x' } })

const codexUser = (text: string): string =>
  JSON.stringify({
    timestamp: CLAUDE_TS,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })

const codexAssistant = (text: string): string =>
  JSON.stringify({
    timestamp: CLAUDE_TS,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  })

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!predicate()) throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate`)
}

interface SentBatch {
  sessionId: string
  messages: OutgoingChatMessage[]
  at: number
}

describe('AgentMessageMirror', () => {
  let tmpDir: string
  let home: string
  let sent: SentBatch[]
  let sendAttempts: number
  let failSend: boolean
  let headSeqBySession: Map<string, number>
  let cleared: string[]
  let codexFiles: Map<string, string>
  let mirror: AgentMessageMirror

  const makeMirror = (
    overrides: {
      flushGapMs?: number
      claudeGuessGraceMs?: number
      fetchHeadSeq?: (sessionId: string) => Promise<number>
    } = {},
  ): AgentMessageMirror =>
    new AgentMessageMirror({
      resolveCodexTranscript: (sessionId) => codexFiles.get(sessionId) ?? null,
      sendAppend: async (sessionId, messages) => {
        sendAttempts++
        if (failSend) throw new Error('convex down')
        sent.push({ sessionId, messages: messages.map((m) => ({ ...m })), at: Date.now() })
      },
      fetchHeadSeq:
        overrides.fetchHeadSeq ?? (async (sessionId) => headSeqBySession.get(sessionId) ?? -1),
      clearSession: async (sessionId) => {
        cleared.push(sessionId)
      },
      // Tight timings for fast tests; production uses the defaults. The zero
      // grace lets fallback-path tests guess immediately — the grace itself is
      // exercised by its own test below.
      pollIntervalMs: 25,
      flushGapMs: overrides.flushGapMs ?? 0,
      claudeGuessGraceMs: overrides.claudeGuessGraceMs ?? 0,
      home,
    })

  const messagesFor = (sessionId: string): OutgoingChatMessage[] =>
    sent.filter((b) => b.sessionId === sessionId).flatMap((b) => b.messages)

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-message-mirror-'))
    home = path.join(tmpDir, 'home')
    fs.mkdirSync(home, { recursive: true })
    sent = []
    sendAttempts = 0
    failSend = false
    headSeqBySession = new Map()
    cleared = []
    codexFiles = new Map()
    mirror = makeMirror()
  })

  afterEach(() => {
    mirror.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Track one claude session and pin it to `file` via the hook path. */
  const trackClaude = (sessionId: string, file: string): void => {
    mirror.setSessions([{ sessionId, agent: 'claude', cwd: path.join(tmpDir, 'cwd') }])
    mirror.noteClaudeTranscript(sessionId, file)
  }

  describe('hook-pushed question forms', () => {
    const QUESTION_INPUT = {
      questions: [
        {
          question: 'Which layout?',
          header: 'Layout',
          options: [{ label: 'Sidebar', preview: 'nav | body' }, { label: 'Top bar' }],
        },
      ],
    }

    it('mirrors a form the moment the hook reports it, without waiting for the transcript', async () => {
      const file = path.join(tmpDir, 'claude.jsonl')
      fs.writeFileSync(file, claudeUser('u1', 'hello') + '\n')
      trackClaude('s1', file)
      await waitFor(() => messagesFor('s1').length === 1)

      mirror.noteClaudeQuestion('s1', 'toolu_abc', QUESTION_INPUT)
      await waitFor(() => messagesFor('s1').length === 2)

      const pushed = messagesFor('s1')[1]
      expect(pushed.uid).toBe('askq:toolu_abc')
      expect(pushed.role).toBe('assistant')
      expect(pushed.blocks).toEqual([
        {
          kind: 'question',
          id: 'toolu_abc',
          questions: [
            {
              question: 'Which layout?',
              header: 'Layout',
              // The preview itself isn't mirrored, only that the form has one —
              // it changes which keys answer the TUI.
              hasPreview: true,
              options: [{ label: 'Sidebar' }, { label: 'Top bar' }],
            },
          ],
        },
      ])
    })

    it('shares one row with the transcript copy, so the form renders once', async () => {
      const file = path.join(tmpDir, 'claude.jsonl')
      fs.writeFileSync(file, claudeUser('u1', 'hello') + '\n')
      trackClaude('s1', file)
      await waitFor(() => messagesFor('s1').length === 1)

      mirror.noteClaudeQuestion('s1', 'toolu_abc', QUESTION_INPUT)
      await waitFor(() => messagesFor('s1').length === 2)
      const hookSeq = messagesFor('s1')[1].seq

      // The transcript record for the same tool_use arrives later.
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          uuid: 'uu-ask',
          timestamp: CLAUDE_TS,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_abc', name: 'AskUserQuestion', input: QUESTION_INPUT }],
          },
        }) + '\n',
      )
      await waitFor(() => messagesFor('s1').length === 3)

      const transcriptCopy = messagesFor('s1')[2]
      // Same uid ⇒ appendMessages upserts onto the hook row (and keeps its seq)
      // instead of rendering a second card. A NEW seq here is what would double
      // it up on the phone.
      expect(transcriptCopy.uid).toBe('askq:toolu_abc')
      expect(transcriptCopy.seq).toBeGreaterThan(hookSeq)
    })

    it('ignores a malformed form and an unknown session', async () => {
      const file = path.join(tmpDir, 'claude.jsonl')
      fs.writeFileSync(file, claudeUser('u1', 'hello') + '\n')
      trackClaude('s1', file)
      await waitFor(() => messagesFor('s1').length === 1)

      mirror.noteClaudeQuestion('s1', 'toolu_bad', { questions: [{ question: 'no options', options: [] }] })
      mirror.noteClaudeQuestion('nope', 'toolu_abc', QUESTION_INPUT)
      await new Promise((r) => setTimeout(r, 80))
      expect(messagesFor('s1')).toHaveLength(1)
      expect(messagesFor('nope')).toHaveLength(0)
    })
  })

  it('seeds a first attach with the last 80 messages, in batches of at most 40', async () => {
    const file = path.join(tmpDir, 'claude.jsonl')
    const lines: string[] = []
    for (let i = 1; i <= 100; i++) lines.push(claudeUser(`u${i}`, `message ${i}`))
    fs.writeFileSync(file, lines.join('\n') + '\n')

    trackClaude('s1', file)
    await waitFor(() => messagesFor('s1').length >= 80)

    const messages = messagesFor('s1')
    expect(messages).toHaveLength(80)
    // The backfill keeps the LAST 80: 21..100, in file order.
    expect(messages[0].uid).toBe('u21')
    expect(messages[79].uid).toBe('u100')
    for (const batch of sent) expect(batch.messages.length).toBeLessThanOrEqual(40)
    // headSeq was -1, so the prime is epoch-anchored (see flush); the seqs run
    // contiguously from it across the batches.
    const base = messages[0].seq
    expect(messages.map((m) => m.seq)).toEqual([...Array(80).keys()].map((k) => base + k))
    expect(messages[0].role).toBe('user')
    expect(messages[0].blocks).toEqual([{ kind: 'text', text: 'message 21' }])
  })

  it('streams appended lines incrementally with climbing seqs', async () => {
    const file = path.join(tmpDir, 'claude.jsonl')
    fs.writeFileSync(file, claudeUser('u1', 'first') + '\n')
    trackClaude('s1', file)
    await waitFor(() => messagesFor('s1').length >= 1)

    fs.appendFileSync(file, claudeUser('u2', 'second') + '\n' + claudeUser('u3', 'third') + '\n')
    await waitFor(() => messagesFor('s1').length >= 3)

    const messages = messagesFor('s1')
    expect(messages.map((m) => m.uid)).toEqual(['u1', 'u2', 'u3'])
    const base = messages[0].seq
    expect(messages.map((m) => m.seq)).toEqual([base, base + 1, base + 2])
  })

  it('carries a partial line across polls until its newline arrives', async () => {
    const file = path.join(tmpDir, 'claude.jsonl')
    fs.writeFileSync(file, '')
    trackClaude('s1', file)
    // Settle so the attach sees the empty file before the torn write begins.
    await new Promise((r) => setTimeout(r, 80))

    const line = claudeUser('u1', 'hello world')
    fs.appendFileSync(file, line.slice(0, 30))
    await new Promise((r) => setTimeout(r, 100))
    expect(messagesFor('s1')).toHaveLength(0)

    fs.appendFileSync(file, line.slice(30) + '\n')
    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1')[0].blocks).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('treats a path swap as a conversation swap: clear, reset marker, re-seed, seq never resets', async () => {
    const fileA = path.join(tmpDir, 'a.jsonl')
    fs.writeFileSync(fileA, claudeUser('u1', 'one') + '\n' + claudeUser('u2', 'two') + '\n')
    trackClaude('s1', fileA)
    await waitFor(() => messagesFor('s1').length >= 2)
    expect(cleared).toEqual([])

    // The hook reports a different transcript (resume fork, or a fresh
    // conversation): the stored rows describe a file no longer shown.
    const fileB = path.join(tmpDir, 'b.jsonl')
    fs.writeFileSync(fileB, claudeUser('u2', 'two') + '\n' + claudeUser('u3', 'three') + '\n')
    mirror.noteClaudeTranscript('s1', fileB)
    await waitFor(() => messagesFor('s1').length >= 5)

    expect(cleared).toEqual(['s1'])
    const messages = messagesFor('s1')
    // The reset marker precedes the new file's seed, so a mounted pane cuts
    // its held copy before the re-pushed rows land.
    expect(messages.map((m) => m.uid)).toEqual(['u1', 'u2', 'reset:b', 'u2', 'u3'])
    expect(messages[2].role).toBe('system')
    expect(messages[2].blocks).toEqual([{ kind: 'reset' }])
    // Seqs continue above everything already handed out — never reset.
    const base = messages[0].seq
    expect(messages.map((m) => m.seq)).toEqual([base, base + 1, base + 2, base + 3, base + 4])
  })

  it('clears the previous conversation a cwd guess pushed once the hook reports the real file', async () => {
    // The reported bug: a fresh claude session starts in a tracked pane. Before
    // its hook fires, the fallback glob attaches to the newest transcript in
    // the project dir — the PREVIOUS conversation — and pushes its tail. The
    // hook's correction must sweep those rows out, not just re-aim the tail.
    const cwd = path.join(tmpDir, 'work')
    const dir = claudeProjectDir(cwd, home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'old-session.jsonl'), claudeUser('old1', 'previous conversation') + '\n')
    mirror.setSessions([{ sessionId: 's1', agent: 'claude', cwd }])
    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1')[0].uid).toBe('old1')
    expect(cleared).toEqual([])

    const fresh = path.join(dir, 'fresh-session.jsonl')
    fs.writeFileSync(fresh, claudeUser('new1', 'fresh conversation') + '\n')
    mirror.noteClaudeTranscript('s1', fresh)
    await waitFor(() => messagesFor('s1').some((m) => m.uid === 'new1'))

    expect(cleared).toEqual(['s1'])
    expect(messagesFor('s1').map((m) => m.uid)).toEqual(['old1', 'reset:fresh-session', 'new1'])
    const seqs = messagesFor('s1').map((m) => m.seq)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
  })

  it('primes seq from the persisted head on the first push', async () => {
    // A head ahead of the clock proves the persisted side of the prime is
    // honored: an epoch-anchored prime alone would land below it and re-issue
    // seqs the backend already stored.
    const head = Date.now() + 60_000
    headSeqBySession.set('s1', head)
    const file = path.join(tmpDir, 'claude.jsonl')
    fs.writeFileSync(file, claudeUser('u1', 'hi') + '\n')
    trackClaude('s1', file)
    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1')[0].seq).toBe(head + 1)
  })

  it('re-primes a cleared session above its old seqs after a mirror restart', async () => {
    const file = path.join(tmpDir, 'claude.jsonl')
    fs.writeFileSync(file, claudeUser('u1', 'first conversation') + '\n')
    trackClaude('s1', file)
    await waitFor(() => messagesFor('s1').length >= 1)
    const oldTop = messagesFor('s1')[0].seq

    // Untrack clears the stored rows (headSeq back to -1 — the fake's default
    // mirrors that), and a stopped mirror plus a fresh instance is a desktop
    // restart: the in-process counter is gone, so this prime is a cold one.
    mirror.setSessions([])
    expect(cleared).toEqual(['s1'])
    mirror.stop()
    // Let the clock tick past the first prime; a restart takes far longer.
    await new Promise((r) => setTimeout(r, 10))
    mirror = makeMirror()

    const respawnFile = path.join(tmpDir, 'claude-respawn.jsonl')
    fs.writeFileSync(respawnFile, claudeUser('u2', 'second conversation') + '\n')
    trackClaude('s1', respawnFile)
    await waitFor(() => messagesFor('s1').length >= 2)

    // A still-mounted ChatPane's afterSeq cursor sits at oldTop; the respawned
    // conversation must land above it or its seq-greater-than subscription
    // never matches again and the chat freezes.
    const respawn = messagesFor('s1')[1]
    expect(respawn.uid).toBe('u2')
    expect(respawn.seq).toBeGreaterThan(oldTop)
  })

  it('drops a batch whose session was untracked while its flush was in flight', async () => {
    // Park the first flush inside its priming fetch so the untrack — which
    // dispatches clearMessages — lands in the window before the append
    // dispatch: the interleaving that would otherwise commit the batch AFTER
    // the clear and resurrect rows for a session the phone no longer lists.
    let headSeqCalls = 0
    let releaseHeadSeq: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseHeadSeq = resolve
    })
    mirror.stop()
    mirror = makeMirror({
      fetchHeadSeq: async () => {
        headSeqCalls++
        await gate
        return -1
      },
    })
    const file = path.join(tmpDir, 'claude.jsonl')
    fs.writeFileSync(file, claudeUser('u1', 'hi') + '\n')
    trackClaude('s1', file)
    await waitFor(() => headSeqCalls >= 1)

    mirror.setSessions([])
    expect(cleared).toEqual(['s1'])
    releaseHeadSeq()
    await new Promise((r) => setTimeout(r, 100))
    expect(sendAttempts).toBe(0)
    expect(messagesFor('s1')).toHaveLength(0)
  })

  it('keeps the batch across failed sends, retries it, and logs once', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      failSend = true
      const file = path.join(tmpDir, 'claude.jsonl')
      fs.writeFileSync(file, claudeUser('u1', 'one') + '\n' + claudeUser('u2', 'two') + '\n')
      trackClaude('s1', file)

      await waitFor(() => sendAttempts >= 3)
      expect(sent).toHaveLength(0)
      const appendErrors = errorSpy.mock.calls.filter((args) =>
        String(args[0]).includes('appendMessages failed'),
      )
      expect(appendErrors).toHaveLength(1)

      failSend = false
      await waitFor(() => messagesFor('s1').length >= 2)
      // Exactly once each — the retried batch is the same batch, not a re-parse.
      await new Promise((r) => setTimeout(r, 100))
      const messages = messagesFor('s1')
      expect(messages.map((m) => m.uid)).toEqual(['u1', 'u2'])
      const base = messages[0].seq
      expect(messages.map((m) => m.seq)).toEqual([base, base + 1])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('clears the stored conversation when a session leaves the tracked set', async () => {
    const file = path.join(tmpDir, 'claude.jsonl')
    fs.writeFileSync(file, claudeUser('u1', 'hi') + '\n')
    trackClaude('s1', file)
    await waitFor(() => messagesFor('s1').length >= 1)

    mirror.setSessions([])
    expect(cleared).toEqual(['s1'])

    // The dropped session's transcript keeps growing; nothing may be pushed.
    fs.appendFileSync(file, claudeUser('u2', 'late') + '\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(messagesFor('s1')).toHaveLength(1)
  })

  it('tails codex rollouts via the injected resolver, with line-number uids', async () => {
    const file = path.join(tmpDir, 'rollout-2026-07-27T09-00-00-abc.jsonl')
    fs.writeFileSync(file, [codexMeta(), codexUser('do the thing'), codexAssistant('done')].join('\n') + '\n')
    codexFiles.set('c1', file)
    mirror.setSessions([{ sessionId: 'c1', agent: 'codex', cwd: '/x' }])
    await waitFor(() => messagesFor('c1').length >= 2)

    const messages = messagesFor('c1')
    // session_meta is line 1 and parses to nothing; the conversation is 2..3.
    expect(messages.map((m) => m.uid)).toEqual([
      'rollout-2026-07-27T09-00-00-abc:2',
      'rollout-2026-07-27T09-00-00-abc:3',
    ])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('keeps codex line numbers file-absolute when the backfill window starts mid-file', async () => {
    // A first line larger than the 512KB window forces the attach to start
    // inside it. The dropped fragment still counts as line 1, so the records
    // behind it must keep their absolute numbers — a restart that re-derives
    // different uids for the same lines would duplicate the conversation.
    const file = path.join(tmpDir, 'rollout-2026-07-27T10-00-00-big.jsonl')
    const bloat = JSON.stringify({ type: 'noise', payload: { pad: 'x'.repeat(600_000) } })
    fs.writeFileSync(file, [bloat, codexUser('after the bloat'), codexAssistant('ok')].join('\n') + '\n')
    codexFiles.set('c1', file)
    mirror.setSessions([{ sessionId: 'c1', agent: 'codex', cwd: '/x' }])
    await waitFor(() => messagesFor('c1').length >= 2)

    expect(messagesFor('c1').map((m) => m.uid)).toEqual([
      'rollout-2026-07-27T10-00-00-big:2',
      'rollout-2026-07-27T10-00-00-big:3',
    ])
  })

  it('falls back to the newest transcript in the claude project dir when no hook has fired', async () => {
    const cwd = path.join(tmpDir, 'work')
    const dir = claudeProjectDir(cwd, home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.jsonl'), claudeUser('u1', 'from glob') + '\n')

    mirror.setSessions([{ sessionId: 's1', agent: 'claude', cwd }])
    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1')[0].uid).toBe('u1')
  })

  it('holds the cwd guess for the grace window so SessionStart can pin the real file first', async () => {
    mirror.stop()
    mirror = makeMirror({ claudeGuessGraceMs: 500 })
    const cwd = path.join(tmpDir, 'work')
    const dir = claudeProjectDir(cwd, home)
    fs.mkdirSync(dir, { recursive: true })
    // The trap: the newest transcript in the project dir belongs to a PREVIOUS
    // conversation. A fresh session must not surface it while the hook is due.
    fs.writeFileSync(path.join(dir, 'old-session.jsonl'), claudeUser('old1', 'previous conversation') + '\n')

    mirror.setSessions([{ sessionId: 's1', agent: 'claude', cwd }])
    await new Promise((r) => setTimeout(r, 150))
    expect(messagesFor('s1')).toHaveLength(0)

    // The hook lands inside the window: the foreign file is never touched.
    const fresh = path.join(dir, 'fresh-session.jsonl')
    fs.writeFileSync(fresh, claudeUser('new1', 'fresh conversation') + '\n')
    mirror.noteClaudeTranscript('s1', fresh)
    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1').map((m) => m.uid)).toEqual(['new1'])
    expect(cleared).toEqual([])

    // A session whose hooks stay silent still gets the fallback once the
    // grace expires (desktop restart over an idle conversation).
    mirror.setSessions([
      { sessionId: 's1', agent: 'claude', cwd },
      { sessionId: 's2', agent: 'claude', cwd: path.join(tmpDir, 'other') },
    ])
    const otherDir = claudeProjectDir(path.join(tmpDir, 'other'), home)
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'idle.jsonl'), claudeUser('idle1', 'still here') + '\n')
    await waitFor(() => messagesFor('s2').length >= 1)
    expect(messagesFor('s2')[0].uid).toBe('idle1')
  })

  it('adopts a hook transcript reported before the session was ever tracked', async () => {
    mirror.stop()
    mirror = makeMirror({ claudeGuessGraceMs: 50 })
    const cwd = path.join(tmpDir, 'work')
    const dir = claudeProjectDir(cwd, home)
    fs.mkdirSync(dir, { recursive: true })
    // The trap this shipped as: SessionStart fires while claude is still
    // booting, so it lands BEFORE the OSC title marks the pane as claude and
    // setSessions tracks it. The report used to be dropped for want of an
    // entry, and the grace then expired onto this foreign conversation.
    fs.writeFileSync(path.join(dir, 'old-session.jsonl'), claudeUser('old1', 'someone else') + '\n')
    const fresh = path.join(dir, 'fresh-session.jsonl')
    mirror.noteClaudeTranscript('s1', fresh)

    // Claude writes the file only once it has something to record — the hook
    // reports the path before it exists, which must not cost us the pairing.
    mirror.setSessions([{ sessionId: 's1', agent: 'claude', cwd }])
    await new Promise((r) => setTimeout(r, 150))
    expect(messagesFor('s1')).toHaveLength(0)

    fs.writeFileSync(fresh, claudeUser('new1', 'this session') + '\n')
    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1').map((m) => m.uid)).toEqual(['new1'])
    // Never attached to the foreign file, so nothing to swap away from.
    expect(cleared).toEqual([])
  })

  it('keeps a pre-tracking claude report off a codex session in the same pane', async () => {
    const cwd = path.join(tmpDir, 'work')
    const dir = claudeProjectDir(cwd, home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'claude.jsonl'), claudeUser('c1', 'claude turn') + '\n')
    mirror.noteClaudeTranscript('s1', path.join(dir, 'claude.jsonl'))

    // Same pane comes up as codex: the rollout the watcher resolved wins, and
    // the remembered claude path must not hijack it via hookFile.
    const rollout = path.join(tmpDir, 'rollout.jsonl')
    fs.writeFileSync(rollout, codexUser('codex turn') + '\n')
    codexFiles.set('s1', rollout)
    mirror.setSessions([{ sessionId: 's1', agent: 'codex', cwd }])

    await waitFor(() => messagesFor('s1').length >= 1)
    expect(messagesFor('s1')[0].uid).toBe('rollout:1')
  })

  it('spaces appendMessages calls at least flushGapMs apart per session', async () => {
    mirror.stop()
    mirror = makeMirror({ flushGapMs: 200 })
    const file = path.join(tmpDir, 'claude.jsonl')
    const lines: string[] = []
    for (let i = 1; i <= 100; i++) lines.push(claudeUser(`u${i}`, `message ${i}`))
    fs.writeFileSync(file, lines.join('\n') + '\n')

    trackClaude('s1', file)
    await waitFor(() => messagesFor('s1').length >= 80)

    const batches = sent.filter((b) => b.sessionId === 's1')
    expect(batches).toHaveLength(2)
    // Allow a little clock skew between the gap check and the recorded time.
    expect(batches[1].at - batches[0].at).toBeGreaterThanOrEqual(180)
  })
})
