import { describe, expect, it } from 'vitest'
import { pickAssignableJsonlPath, pickBestJsonlPath, rankJsonlCandidates, type JsonlCandidate } from './claude-jsonl-matcher'

const createdAt = 10_000

describe('rankJsonlCandidates', () => {
  it('prefers files created near the watch time', () => {
    const candidates: JsonlCandidate[] = [
      { path: 'older.jsonl', birthtime: 1_000, mtime: 20_000 },
      { path: 'near.jsonl', birthtime: 10_100, mtime: 11_000 },
      { path: 'later.jsonl', birthtime: 15_000, mtime: 16_000 },
    ]

    expect(rankJsonlCandidates(candidates, createdAt).map((candidate) => candidate.path)).toEqual([
      'near.jsonl',
      'later.jsonl',
      'older.jsonl',
    ])
  })
})

describe('pickAssignableJsonlPath', () => {
  it('skips files already assigned to another session', () => {
    const assignments = new Map<string, string | null>([
      ['shared.jsonl', 'claude-1'],
      ['target.jsonl', null],
    ])

    const candidates: JsonlCandidate[] = [
      { path: 'shared.jsonl', birthtime: 10_050, mtime: 12_000 },
      { path: 'target.jsonl', birthtime: 10_100, mtime: 11_500 },
    ]

    expect(pickAssignableJsonlPath(candidates, createdAt, assignments, 'claude-2')).toBe('target.jsonl')
  })

  it('allows a session to keep its current file', () => {
    const assignments = new Map<string, string | null>([
      ['owned.jsonl', 'claude-2'],
    ])

    const candidates: JsonlCandidate[] = [
      { path: 'owned.jsonl', birthtime: 10_050, mtime: 12_000 },
    ]

    expect(pickAssignableJsonlPath(candidates, createdAt, assignments, 'claude-2')).toBe('owned.jsonl')
  })
})

describe('pickBestJsonlPath', () => {
  it('returns the best-ranked candidate even when ownership will be resolved later', () => {
    const candidates: JsonlCandidate[] = [
      { path: 'older.jsonl', birthtime: 5_000, mtime: 20_000 },
      { path: 'target.jsonl', birthtime: 10_050, mtime: 11_000 },
    ]

    expect(pickBestJsonlPath(candidates, createdAt)).toBe('target.jsonl')
  })
})
