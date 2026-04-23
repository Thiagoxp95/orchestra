// apps/desktop/src/main/claude-transcript-tail.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeCwdForClaudePath, watchClaudeTranscript, stopAllClaudeWatchers } from './claude-transcript-tail'
import { __resetForTests, getLastUserMessage } from './last-user-message-store'

describe('encodeCwdForClaudePath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeCwdForClaudePath('/Users/txp/Pessoal/orchestra')).toBe('-Users-txp-Pessoal-orchestra')
  })
})

describe('watchClaudeTranscript', () => {
  let tmpRoot: string
  let cwd: string
  let projectsDir: string

  beforeEach(() => {
    __resetForTests()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-claude-'))
    cwd = path.join(tmpRoot, 'project')
    fs.mkdirSync(cwd, { recursive: true })
    projectsDir = path.join(tmpRoot, '.claude', 'projects', encodeCwdForClaudePath(cwd))
    fs.mkdirSync(projectsDir, { recursive: true })
  })

  afterEach(() => {
    stopAllClaudeWatchers()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('detects last user prompt in newest jsonl and pushes to store', async () => {
    const file = path.join(projectsDir, 'a.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hello world' } }) + '\n')

    watchClaudeTranscript('s1', cwd, { homeDir: tmpRoot })
    // initial read is synchronous-ish; allow fs.watch debounce
    await new Promise((r) => setTimeout(r, 50))

    expect(getLastUserMessage('s1')?.text).toBe('hello world')
  })

  it('updates when file gains a new user message', async () => {
    const file = path.join(projectsDir, 'a.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'first' } }) + '\n')
    watchClaudeTranscript('s1', cwd, { homeDir: tmpRoot })
    await new Promise((r) => setTimeout(r, 50))

    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'second' } }) + '\n')
    await new Promise((r) => setTimeout(r, 250))

    expect(getLastUserMessage('s1')?.text).toBe('second')
  })
})
