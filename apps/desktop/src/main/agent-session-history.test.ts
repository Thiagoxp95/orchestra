import { describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findFirstCodexUserMessage,
  listRecentAgentSessions,
  normalizeCodexUserMessage,
  parseClaudeTranscriptTail,
  parseCodexSessionMeta,
  parseCodexTranscriptTail,
  summarize,
} from './agent-session-history'

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

/** Padding so fixtures clear the "metadata-only stub" size floor. */
function pad(): unknown {
  return { type: 'file-history-snapshot', blob: 'x'.repeat(700) }
}

const claudeUser = (text: string, ts = '2026-07-23T10:00:00.000Z') => ({
  type: 'user',
  sessionId: 'claude-1',
  cwd: '/repo',
  gitBranch: 'main',
  timestamp: ts,
  message: { role: 'user', content: text },
})

const claudeAssistant = (text: string, ts = '2026-07-23T10:01:00.000Z') => ({
  type: 'assistant',
  sessionId: 'claude-1',
  cwd: '/repo',
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

describe('summarize', () => {
  test('collapses whitespace and clips long text', () => {
    expect(summarize('  hello\n\n  world  ')).toBe('hello world')
    expect(summarize('abcdef', 4)).toBe('abc…')
    expect(summarize('   ')).toBeNull()
    expect(summarize(undefined)).toBeNull()
  })
})

describe('parseClaudeTranscriptTail', () => {
  test('pulls the title, last messages and location', () => {
    const parsed = parseClaudeTranscriptTail(
      jsonl(
        claudeUser('first ask'),
        claudeAssistant('first answer'),
        { type: 'ai-title', aiTitle: 'Fix the mirror', sessionId: 'claude-1' },
        claudeUser('second ask', '2026-07-23T10:02:00.000Z'),
        claudeAssistant('second answer', '2026-07-23T10:03:00.000Z'),
      ),
      false,
    )
    expect(parsed.hasMessages).toBe(true)
    expect(parsed.sessionId).toBe('claude-1')
    expect(parsed.cwd).toBe('/repo')
    expect(parsed.gitBranch).toBe('main')
    expect(parsed.title).toBe('Fix the mirror')
    expect(parsed.lastUserMessage).toBe('second ask')
    expect(parsed.lastAssistantMessage).toBe('second answer')
    expect(parsed.lastActivityAt).toBe(Date.parse('2026-07-23T10:03:00.000Z'))
  })

  test('drops the leading fragment when the read started mid-record', () => {
    const tail = `"content":"truncated"}}\n${JSON.stringify(claudeAssistant('real answer'))}\n`
    const parsed = parseClaudeTranscriptTail(tail, true)
    expect(parsed.lastAssistantMessage).toBe('real answer')
  })

  test('ignores sub-agent turns, tool plumbing and slash-command echoes', () => {
    const parsed = parseClaudeTranscriptTail(
      jsonl(
        claudeUser('typed by a human'),
        { ...claudeUser('sidechain ask'), isSidechain: true },
        { ...claudeAssistant('sidechain answer'), isSidechain: true },
        claudeUser('<command-name>/clear</command-name>'),
        { ...claudeUser('meta note'), isMeta: true },
        {
          type: 'user',
          sessionId: 'claude-1',
          cwd: '/repo',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'exit 0' }] },
        },
      ),
      false,
    )
    expect(parsed.lastUserMessage).toBe('typed by a human')
    expect(parsed.lastAssistantMessage).toBeUndefined()
  })

  test('reports no messages for a metadata-only tail', () => {
    const parsed = parseClaudeTranscriptTail(
      jsonl(
        { type: 'mode', mode: 'normal', sessionId: 'claude-1' },
        { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'claude-1' },
      ),
      false,
    )
    expect(parsed.hasMessages).toBe(false)
  })
})

describe('parseCodexSessionMeta', () => {
  test('reads session id and cwd', () => {
    const meta = parseCodexSessionMeta(
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'codex-1', cwd: '/repo', timestamp: '2026-07-23T10:00:00.000Z', thread_source: 'user' },
      }),
    )
    expect(meta?.sessionId).toBe('codex-1')
    expect(meta?.cwd).toBe('/repo')
    expect(meta?.isSubagent).toBe(false)
  })

  test('flags sub-worker rollouts', () => {
    const spawned = parseCodexSessionMeta(
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-2', cwd: '/repo', thread_source: 'subagent' } }),
    )
    expect(spawned?.isSubagent).toBe(true)

    const forked = parseCodexSessionMeta(
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-3', cwd: '/repo', parent_thread_id: 'codex-1' } }),
    )
    expect(forked?.isSubagent).toBe(true)
  })

  test('returns null for a non-meta or unparseable first line', () => {
    expect(parseCodexSessionMeta(JSON.stringify({ type: 'event_msg', payload: {} }))).toBeNull()
    expect(parseCodexSessionMeta('{not json')).toBeNull()
  })
})

describe('normalizeCodexUserMessage', () => {
  test('keeps a plain prompt', () => {
    expect(normalizeCodexUserMessage('  fix the flaky test  ')).toBe('fix the flaky test')
  })

  test('unwraps the Codex Desktop attachment preamble', () => {
    const raw = '\n# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request for Codex:\nmake it pixel perfect\n'
    expect(normalizeCodexUserMessage(raw)).toBe('make it pixel perfect')
  })

  test('drops a preamble whose request lives in the attachment', () => {
    const raw = '\n# Files mentioned by the user:\n\n## pasted-text.txt: /tmp/pasted.txt\n\n## My request for Codex:\n\n'
    expect(normalizeCodexUserMessage(raw)).toBeNull()
    expect(normalizeCodexUserMessage('\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n')).toBeNull()
  })
})

describe('findFirstCodexUserMessage', () => {
  const head = jsonl(
    { timestamp: '2026-07-23T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-23T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n' } },
    { timestamp: '2026-07-23T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'the actual opening ask' } },
    { timestamp: '2026-07-23T10:00:03.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'a later follow-up' } },
  )

  test('returns the first prompt a human actually wrote', () => {
    expect(findFirstCodexUserMessage(head, false)).toBe('the actual opening ask')
  })

  test('drops the trailing fragment when the head window cut a record', () => {
    const truncated = `${head.trimEnd()}\n{"type":"event_msg","payload":{"type":"user_mess`
    expect(findFirstCodexUserMessage(truncated, true)).toBe('the actual opening ask')
  })

  test('returns null when the window holds no prompt', () => {
    expect(findFirstCodexUserMessage(jsonl({ type: 'event_msg', payload: { type: 'token_count' } }), false)).toBeNull()
  })
})

describe('parseCodexTranscriptTail', () => {
  test('takes the newest user and agent messages', () => {
    const parsed = parseCodexTranscriptTail(
      jsonl(
        { timestamp: '2026-07-23T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
        { timestamp: '2026-07-23T10:00:30.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } },
        { timestamp: '2026-07-23T10:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'thing done' } },
        { timestamp: '2026-07-23T10:01:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'thing really done' } },
      ),
      false,
    )
    expect(parsed.hasMessages).toBe(true)
    expect(parsed.lastUserMessage).toBe('do the thing')
    expect(parsed.lastAssistantMessage).toBe('thing really done')
    expect(parsed.lastActivityAt).toBe(Date.parse('2026-07-23T10:01:01.000Z'))
  })

  test('reports no messages when only bookkeeping events are present', () => {
    const parsed = parseCodexTranscriptTail(
      jsonl({ timestamp: '2026-07-23T10:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {} } }),
      false,
    )
    expect(parsed.hasMessages).toBe(false)
  })
})

describe('listRecentAgentSessions', () => {
  test('returns both agents newest-first, skipping stubs and sub-workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-history-'))
    const claudeRoot = join(root, 'claude', 'projects', '-repo')
    const codexRoot = join(root, 'codex', 'sessions', '2026', '07', '23')
    await mkdir(claudeRoot, { recursive: true })
    await mkdir(codexRoot, { recursive: true })

    await writeFile(
      join(claudeRoot, 'claude-1.jsonl'),
      jsonl(
        pad(),
        claudeUser('ship the resume button'),
        { type: 'ai-title', aiTitle: 'Resume button', sessionId: 'claude-1' },
        claudeAssistant('shipped it', '2026-07-23T10:05:00.000Z'),
      ),
    )
    // Metadata-only transcript: nothing to summarize, nothing to resume.
    await writeFile(
      join(claudeRoot, 'claude-stub.jsonl'),
      jsonl(pad(), { type: 'mode', mode: 'normal', sessionId: 'claude-stub' }),
    )
    await writeFile(
      join(codexRoot, 'rollout-2026-07-23T09-00-00-codex-1.jsonl'),
      jsonl(
        { timestamp: '2026-07-23T09:00:00.000Z', type: 'session_meta', payload: { session_id: 'codex-1', cwd: root, thread_source: 'user' } },
        pad(),
        { timestamp: '2026-07-23T09:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'review the diff' } },
        { timestamp: '2026-07-23T09:02:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'looks good' } },
      ),
    )
    await writeFile(
      join(codexRoot, 'rollout-2026-07-23T09-30-00-codex-2.jsonl'),
      jsonl(
        { timestamp: '2026-07-23T09:30:00.000Z', type: 'session_meta', payload: { session_id: 'codex-2', cwd: root, thread_source: 'subagent' } },
        pad(),
        { timestamp: '2026-07-23T09:31:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'sub-worker output' } },
      ),
    )

    const sessions = await listRecentAgentSessions({
      claudeRoot: join(root, 'claude', 'projects'),
      codexRoot: join(root, 'codex', 'sessions'),
    })

    expect(sessions.map((s) => s.sessionId)).toEqual(['claude-1', 'codex-1'])

    const claude = sessions[0]!
    expect(claude.agent).toBe('claude')
    expect(claude.title).toBe('Resume button')
    expect(claude.lastAssistantMessage).toBe('shipped it')
    expect(claude.cwd).toBe('/repo')
    expect(claude.cwdExists).toBe(false)

    const codex = sessions[1]!
    expect(codex.agent).toBe('codex')
    expect(codex.title).toBe('review the diff')
    expect(codex.lastAssistantMessage).toBe('looks good')
    expect(codex.cwd).toBe(root)
    expect(codex.cwdExists).toBe(true)
  })

  test('honours the per-agent limit and the age cutoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-history-'))
    const claudeProjects = join(root, 'claude', 'projects')
    const claudeRoot = join(claudeProjects, '-repo')
    await mkdir(claudeRoot, { recursive: true })
    for (let i = 0; i < 3; i++) {
      await writeFile(
        join(claudeRoot, `claude-${i}.jsonl`),
        jsonl(
          pad(),
          { ...claudeUser(`ask ${i}`), sessionId: `claude-${i}` },
          { ...claudeAssistant(`answer ${i}`), sessionId: `claude-${i}` },
        ),
      )
    }

    // Distinct mtimes, oldest first — transcripts are parsed concurrently, so a
    // batch can produce more entries than the limit and must still keep the newest.
    for (let i = 0; i < 3; i++) {
      const when = new Date(Date.now() - (3 - i) * 60 * 60 * 1000)
      await utimes(join(claudeRoot, `claude-${i}.jsonl`), when, when)
    }

    const limited = await listRecentAgentSessions({ claudeRoot: claudeProjects, codexRoot: join(root, 'none'), limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited.map((s) => s.sessionId)).toEqual(['claude-2', 'claude-1'])

    // Age out every transcript by backdating it a week.
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 3; i++) {
      await utimes(join(claudeRoot, `claude-${i}.jsonl`), weekAgo, weekAgo)
    }
    const stale = await listRecentAgentSessions({ claudeRoot: claudeProjects, codexRoot: join(root, 'none'), maxAgeDays: 1 })
    expect(stale).toHaveLength(0)
  })

  test('survives missing transcript roots', async () => {
    const sessions = await listRecentAgentSessions({
      claudeRoot: join(tmpdir(), 'does-not-exist-claude'),
      codexRoot: join(tmpdir(), 'does-not-exist-codex'),
    })
    expect(sessions).toEqual([])
  })
})
