const CODEX_INTERRUPTED_PROMPT_RE = /Conversation interrupted\s*-\s*tell the model what to do differently/i

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
