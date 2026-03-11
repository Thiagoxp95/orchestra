import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doesClaudeJsonlMatchPromptHints, extractClaudeJsonlPromptTexts } from './claude-jsonl-prompts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jsonl-'))
  tempDirs.push(dir)
  return dir
}

function writeJsonlFile(lines: unknown[]): string {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'session.jsonl')
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return filePath
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('extractClaudeJsonlPromptTexts', () => {
  it('extracts a plain string user prompt', () => {
    expect(extractClaudeJsonlPromptTexts({
      type: 'user',
      message: {
        content: 'Fix the sidebar binding bug',
      },
    })).toEqual(['Fix the sidebar binding bug'])
  })

  it('extracts text blocks from structured user content', () => {
    expect(extractClaudeJsonlPromptTexts({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'First prompt' },
          { type: 'tool_result', content: 'ignored' },
          'Second prompt',
        ],
      },
    })).toEqual(['First prompt', 'Second prompt'])
  })
})

describe('doesClaudeJsonlMatchPromptHints', () => {
  it('matches prompts after normalizing whitespace and casing', () => {
    const filePath = writeJsonlFile([
      {
        type: 'user',
        message: {
          content: '  Explain   THE   failing  session binding ',
        },
      },
    ])

    expect(doesClaudeJsonlMatchPromptHints(filePath, ['explain the failing session binding'])).toBe(true)
  })

  it('returns false when the jsonl does not contain the session prompts', () => {
    const filePath = writeJsonlFile([
      {
        type: 'user',
        message: {
          content: 'Prompt from another terminal session',
        },
      },
    ])

    expect(doesClaudeJsonlMatchPromptHints(filePath, ['my local prompt history'])).toBe(false)
  })
})
