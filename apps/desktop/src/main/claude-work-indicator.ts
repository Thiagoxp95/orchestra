export type ClaudeWorkState = 'idle' | 'working'

export interface TitleParseResult {
  remainder: string
  titles: string[]
}

const OSC_PREFIX = '\u001b]'
const ST = '\u001b\\'
const BEL = '\u0007'
const CLAUDE_IDLE_TITLE = '✳ Claude Code'

export function extractTerminalTitles(chunk: string, remainder = ''): TitleParseResult {
  const input = remainder + chunk
  const titles: string[] = []
  let cursor = 0

  while (cursor < input.length) {
    const oscStart = input.indexOf(OSC_PREFIX, cursor)
    if (oscStart === -1) {
      return { remainder: '', titles }
    }

    const bodyStart = oscStart + OSC_PREFIX.length
    const belIndex = input.indexOf(BEL, bodyStart)
    const stIndex = input.indexOf(ST, bodyStart)
    const endIndex = [belIndex, stIndex].filter((index) => index !== -1).sort((a, b) => a - b)[0]

    if (endIndex === undefined) {
      return { remainder: input.slice(oscStart), titles }
    }

    const sequenceBody = input.slice(bodyStart, endIndex)
    const separatorIndex = sequenceBody.indexOf(';')
    if (separatorIndex !== -1) {
      const code = sequenceBody.slice(0, separatorIndex)
      const title = sequenceBody.slice(separatorIndex + 1)
      if (code === '0' || code === '2') {
        titles.push(title)
      }
    }

    cursor = endIndex + (endIndex === stIndex ? ST.length : BEL.length)
  }

  return { remainder: '', titles }
}

export function titleToClaudeWorkState(title: string): ClaudeWorkState | null {
  if (!title.endsWith('Claude Code')) return null
  return title === CLAUDE_IDLE_TITLE ? 'idle' : 'working'
}

export function getClaudeWorkStateFromChunk(
  chunk: string,
  remainder = ''
): { remainder: string; state: ClaudeWorkState | null } {
  const parsed = extractTerminalTitles(chunk, remainder)
  let state: ClaudeWorkState | null = null

  for (const title of parsed.titles) {
    const nextState = titleToClaudeWorkState(title)
    if (nextState) state = nextState
  }

  return { remainder: parsed.remainder, state }
}

export function isSessionWorking(
  processStatus: string,
  claudeWorkState: ClaudeWorkState | undefined
): boolean {
  if (processStatus === 'claude') return claudeWorkState === 'working'
  return false
}
