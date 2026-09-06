import { describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentSessionIdFromTranscript,
  cursorChatsDir,
  findCursorChat,
  findCursorTranscript,
  listCursorChats,
} from './agent-resume-ids'

const ID_A = '46502127-97dc-451a-81b2-2410f1392a31'
const ID_B = '11112222-3333-4444-5555-666677778888'

describe('agentSessionIdFromTranscript', () => {
  it('reads claude ids off the filename', () => {
    expect(agentSessionIdFromTranscript('claude', `/x/y/${ID_A}.jsonl`)).toBe(ID_A)
  })

  it('reads codex ids past the timestamp, which also contains dashes', () => {
    const file = `/x/2026/09/06/rollout-2026-09-06T10-11-12-${ID_A}.jsonl`
    expect(agentSessionIdFromTranscript('codex', file)).toBe(ID_A)
  })

  it('reads cursor ids off the filename', () => {
    expect(agentSessionIdFromTranscript('cursor', `/x/${ID_A}/${ID_A}.jsonl`)).toBe(ID_A)
  })

  // Resuming the WRONG conversation is worse than offering no resume, so
  // anything that isn't recognizably an id has to come back null.
  it('refuses anything that is not a conversation id', () => {
    expect(agentSessionIdFromTranscript('claude', '/x/summary.jsonl')).toBeNull()
    expect(agentSessionIdFromTranscript('claude', `/x/${ID_A}-partial.jsonl`)).toBeNull()
    expect(agentSessionIdFromTranscript('codex', '/x/rollout-2026-09-06.jsonl')).toBeNull()
  })
})

describe('cursorChatsDir', () => {
  // Verified against a real ~/.cursor tree: cursor keys chats by an md5 of the
  // workspace path. A trailing slash must not produce a different directory.
  it('hashes the workspace path', () => {
    const home = '/home'
    expect(cursorChatsDir('/Users/x/repo', home)).toBe(
      join(home, '.cursor', 'chats', 'bbeb75075652b7b23cbff26cab0f8095'),
    )
    expect(cursorChatsDir('/Users/x/repo/', home)).toBe(cursorChatsDir('/Users/x/repo', home))
  })
})

function seedCursorChat(home: string, cwd: string, chatId: string, mtimeSeconds: number): void {
  const dir = join(cursorChatsDir(cwd, home), chatId)
  mkdirSync(dir, { recursive: true })
  const store = join(dir, 'store.db')
  writeFileSync(store, 'x')
  utimesSync(store, mtimeSeconds, mtimeSeconds)
}

describe('listCursorChats', () => {
  it('returns the workspace chats newest first', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-ids-'))
    const cwd = '/Users/x/repo'
    seedCursorChat(home, cwd, ID_A, 1_000)
    seedCursorChat(home, cwd, ID_B, 2_000)
    expect(listCursorChats(cwd, home).map((c) => c.chatId)).toEqual([ID_B, ID_A])
  })

  it('is empty for a directory cursor has never been run in', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-ids-'))
    expect(listCursorChats('/Users/x/never', home)).toEqual([])
  })

  it('ignores entries that are not conversation ids', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-ids-'))
    const cwd = '/Users/x/repo'
    seedCursorChat(home, cwd, ID_A, 1_000)
    mkdirSync(join(cursorChatsDir(cwd, home), 'scratch'), { recursive: true })
    writeFileSync(join(cursorChatsDir(cwd, home), 'scratch', 'store.db'), 'x')
    expect(listCursorChats(cwd, home).map((c) => c.chatId)).toEqual([ID_A])
  })
})

describe('findCursorChat', () => {
  it('skips a chat another pane has already claimed', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-ids-'))
    const cwd = '/Users/x/repo'
    seedCursorChat(home, cwd, ID_A, 1_000)
    seedCursorChat(home, cwd, ID_B, 2_000)
    expect(findCursorChat(cwd, home, [ID_B])?.chatId).toBe(ID_A)
    expect(findCursorChat(cwd, home, [ID_A, ID_B])).toBeNull()
  })
})

describe('findCursorTranscript', () => {
  it('finds the transcript under whichever project slug holds it', () => {
    const home = mkdtempSync(join(tmpdir(), 'resume-ids-'))
    const dir = join(home, '.cursor', 'projects', 'Users-x-repo', 'agent-transcripts', ID_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ID_A}.jsonl`), '{"role":"user"}\n')
    expect(findCursorTranscript(ID_A, home)).toBe(join(dir, `${ID_A}.jsonl`))
    expect(findCursorTranscript(ID_B, home)).toBeNull()
  })
})
