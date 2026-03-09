// src/daemon/prompt-history-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { PromptHistoryWriter, PromptRecord } from './prompt-history-writer'

// Override PROMPT_HISTORY_DIR for tests
let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-test-'))
  // Monkey-patch the module's PROMPT_HISTORY_DIR
  // We'll use a custom sessionId that includes the testDir path
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

function createWriter(sessionId: string): PromptHistoryWriter {
  // Create a writer and override internal paths for testing
  const writer = new PromptHistoryWriter(sessionId)
  const sessionDir = path.join(testDir, sessionId)
  const promptsPath = path.join(sessionDir, 'prompts.ndjson')
  // Override private fields using Object.defineProperty
  Object.defineProperty(writer, 'sessionDir', { value: sessionDir, writable: true })
  Object.defineProperty(writer, 'promptsPath', { value: promptsPath, writable: true })
  return writer
}

function readRecords(sessionId: string): PromptRecord[] {
  const promptsPath = path.join(testDir, sessionId, 'prompts.ndjson')
  if (!fs.existsSync(promptsPath)) return []
  const content = fs.readFileSync(promptsPath, 'utf8')
  const records: PromptRecord[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    records.push(JSON.parse(line))
  }
  return records
}

describe('PromptHistoryWriter', () => {
  it('saves a prompt on Enter', () => {
    const writer = createWriter('session-1')
    writer.open()

    writer.feedUserInput('fix the sidebar spacing')
    writer.feedUserInput('\r')
    writer.close()

    const records = readRecords('session-1')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('fix the sidebar spacing')
    expect(records[0].sessionId).toBe('session-1')
    expect(records[0].submittedAt).toBeTruthy()
  })

  it('respects backspace edits', () => {
    const writer = createWriter('session-2')
    writer.open()

    // Type "hello", backspace 2, then type "p me"
    writer.feedUserInput('hello')
    writer.feedUserInput('\x7f\x7f')  // backspace twice
    writer.feedUserInput('p me')
    writer.feedUserInput('\r')
    writer.close()

    const records = readRecords('session-2')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('help me')
  })

  it('ignores empty Enter', () => {
    const writer = createWriter('session-3')
    writer.open()

    writer.feedUserInput('\r')
    writer.feedUserInput('\r')
    writer.feedUserInput('\n')
    writer.close()

    const records = readRecords('session-3')
    expect(records).toHaveLength(0)
  })

  it('saves pasted multi-word text correctly', () => {
    const writer = createWriter('session-4')
    writer.open()

    // Simulate paste: full phrase arrives as single data chunk
    writer.feedUserInput('refactor the authentication module to use JWT tokens\r')
    writer.close()

    const records = readRecords('session-4')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('refactor the authentication module to use JWT tokens')
  })

  it('saves multiple prompts in sequence', () => {
    const writer = createWriter('session-5')
    writer.open()

    writer.feedUserInput('first prompt\r')
    writer.feedUserInput('second prompt\r')
    writer.feedUserInput('third prompt\r')
    writer.close()

    const records = readRecords('session-5')
    expect(records).toHaveLength(3)
    expect(records[0].text).toBe('first prompt')
    expect(records[1].text).toBe('second prompt')
    expect(records[2].text).toBe('third prompt')
  })

  it('does not save Ctrl+C (clears buffer instead)', () => {
    const writer = createWriter('session-6')
    writer.open()

    writer.feedUserInput('partial input')
    writer.feedUserInput('\x03')  // Ctrl+C
    writer.feedUserInput('new prompt\r')
    writer.close()

    const records = readRecords('session-6')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('new prompt')
  })

  it('handles CRLF normalization', () => {
    const writer = createWriter('session-7')
    writer.open()

    writer.feedUserInput('crlf test\r\n')
    writer.close()

    const records = readRecords('session-7')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('crlf test')
  })

  it('sessions are isolated', () => {
    const writer1 = createWriter('session-a')
    const writer2 = createWriter('session-b')
    writer1.open()
    writer2.open()

    writer1.feedUserInput('prompt from session a\r')
    writer2.feedUserInput('prompt from session b\r')

    writer1.close()
    writer2.close()

    const records1 = readRecords('session-a')
    const records2 = readRecords('session-b')

    expect(records1).toHaveLength(1)
    expect(records1[0].text).toBe('prompt from session a')
    expect(records1[0].sessionId).toBe('session-a')

    expect(records2).toHaveLength(1)
    expect(records2[0].text).toBe('prompt from session b')
    expect(records2[0].sessionId).toBe('session-b')
  })

  it('handles DEL key (0x08) as backspace', () => {
    const writer = createWriter('session-8')
    writer.open()

    writer.feedUserInput('abc')
    writer.feedUserInput('\x08')  // DEL
    writer.feedUserInput('d\r')
    writer.close()

    const records = readRecords('session-8')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('abd')
  })

  it('backspace on empty buffer is a no-op', () => {
    const writer = createWriter('session-9')
    writer.open()

    writer.feedUserInput('\x7f\x7f\x7f')  // backspace on empty
    writer.feedUserInput('ok\r')
    writer.close()

    const records = readRecords('session-9')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('ok')
  })

  it('Ctrl+D clears compose buffer', () => {
    const writer = createWriter('session-10')
    writer.open()

    writer.feedUserInput('partial')
    writer.feedUserInput('\x04')  // Ctrl+D
    writer.feedUserInput('fresh\r')
    writer.close()

    const records = readRecords('session-10')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('fresh')
  })
})
