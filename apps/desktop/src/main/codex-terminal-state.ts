const CODEX_INTERRUPTED_PROMPT_RE = /Conversation interrupted\s*-\s*tell the model what to do differently/i
const CODEX_PROMPT_READY_RE = /(?:^|\n)\s*›\s+.+\n\s*(?:gpt|o\d|codex|[a-z0-9_.-]+\/[a-z0-9_.:-]+)\S*\s+.+?·\s+~?\//i

// Strip the escape/control noise that often surrounds Codex TUI text before
// matching user-visible status lines.
function normalizeTerminalChunk(chunk: string): string {
  return chunk
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n')
}

export function chunkIndicatesCodexInterruptedPrompt(chunk: string): boolean {
  return CODEX_INTERRUPTED_PROMPT_RE.test(normalizeTerminalChunk(chunk))
}

export function chunkIndicatesCodexPromptReady(chunk: string): boolean {
  const normalized = normalizeTerminalChunk(chunk)
    .replace(/\x07/g, '\n')
  return CODEX_PROMPT_READY_RE.test(normalized)
}
