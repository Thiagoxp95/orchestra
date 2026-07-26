import { describe, expect, test } from 'vitest'
import type { RecentAgentSession } from '../shared/types'
import {
  REMOTE_SESSION_LIMIT,
  normalizeResumeSessionPayload,
  toRemoteAgentSessions,
} from './remote-bridge-agent-sessions'

function session(overrides: Partial<RecentAgentSession> = {}): RecentAgentSession {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    filePath: '/Users/me/.claude/projects/-repo/sess-1.jsonl',
    cwd: '/repo',
    cwdExists: true,
    gitBranch: 'main',
    updatedAt: 1000,
    title: 'Ship the resume sheet',
    lastUserMessage: 'ship it',
    lastAssistantMessage: 'shipped',
    ...overrides,
  }
}

describe('toRemoteAgentSessions', () => {
  test('drops the transcript path and keeps what the phone renders', () => {
    const [entry] = toRemoteAgentSessions([session()])
    expect(entry).toEqual({
      agent: 'claude',
      sessionId: 'sess-1',
      cwd: '/repo',
      cwdExists: true,
      gitBranch: 'main',
      updatedAt: 1000,
      title: 'Ship the resume sheet',
      summary: 'shipped',
      summaryIsUser: false,
    })
    expect(entry).not.toHaveProperty('filePath')
  })

  test('falls back to the user message and flags it as theirs', () => {
    const [entry] = toRemoteAgentSessions([session({ lastAssistantMessage: null })])
    expect(entry.summary).toBe('ship it')
    expect(entry.summaryIsUser).toBe(true)
  })

  test('clips long previews', () => {
    const [entry] = toRemoteAgentSessions([session({ lastAssistantMessage: 'x'.repeat(500) })])
    expect(entry.summary!.length).toBeLessThanOrEqual(180)
    expect(entry.summary!.endsWith('…')).toBe(true)
  })

  test('caps the payload at the newest entries', () => {
    const many = Array.from({ length: REMOTE_SESSION_LIMIT + 25 }, (_, i) =>
      session({ sessionId: `sess-${i}`, updatedAt: i }),
    )
    const out = toRemoteAgentSessions(many)
    expect(out).toHaveLength(REMOTE_SESSION_LIMIT)
    expect(out[0].sessionId).toBe(`sess-${many.length - 1}`)
    expect(out[0].updatedAt).toBeGreaterThan(out[out.length - 1].updatedAt)
  })
})

describe('normalizeResumeSessionPayload', () => {
  test('accepts a complete payload', () => {
    expect(normalizeResumeSessionPayload({ agent: 'codex', sessionId: ' abc ', cwd: ' /repo ' })).toEqual({
      agent: 'codex',
      sessionId: 'abc',
      cwd: '/repo',
    })
  })

  test('rejects anything it could not spawn from', () => {
    expect(normalizeResumeSessionPayload({ agent: 'cursor', sessionId: 'abc', cwd: '/repo' })).toBeNull()
    expect(normalizeResumeSessionPayload({ agent: 'claude', cwd: '/repo' })).toBeNull()
    expect(normalizeResumeSessionPayload({ agent: 'claude', sessionId: 'abc', cwd: '  ' })).toBeNull()
    expect(normalizeResumeSessionPayload(undefined)).toBeNull()
  })
})
