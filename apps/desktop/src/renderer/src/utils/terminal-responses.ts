// xterm.js auto-responds to terminal capability/status queries from full-screen
// TUIs. Those replies must reach the PTY, but they are not human keystrokes and
// should not feed prompt tracking.
const TERM_RESPONSE_RE = /\x1b\[[\?>][\d;]*[cRn]|\x1b\[[IO]|\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g

export interface SplitTerminalResponsesResult {
  input: string
  responses: string
}

export function splitTerminalResponses(data: string): SplitTerminalResponsesResult {
  let responses = ''
  const input = data.replace(TERM_RESPONSE_RE, (match) => {
    responses += match
    return ''
  })

  return { input, responses }
}
