export interface CodexRolloutParseResult {
  lastResponse: string
  workState: 'idle' | 'working'
}

export function parseCodexRolloutLines(lines: string[]): CodexRolloutParseResult {
  let lastResponse = ''
  let workState: 'idle' | 'working' = 'idle'

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    try {
      const entry = JSON.parse(line)

      if (entry.type === 'event_msg') {
        const eventType = entry.payload?.type
        if (eventType === 'task_started' || eventType === 'exec_command_begin') {
          workState = 'working'
        } else if (
          eventType === 'task_complete'
          || eventType === 'turn_aborted'
          || (typeof eventType === 'string' && eventType.endsWith('_approval_request'))
        ) {
          workState = 'idle'
          const message = entry.payload?.last_agent_message
          if (typeof message === 'string' && message.trim()) {
            lastResponse = message.trim()
          }
        } else if (eventType === 'agent_message') {
          const message = entry.payload?.message
          if (typeof message === 'string' && message.trim()) {
            lastResponse = message.trim()
          }
        }
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'message') {
        const role = entry.payload?.role
        const content = entry.payload?.content
        if (role === 'assistant' && Array.isArray(content)) {
          const text = content
            .map((item: { text?: string }) => (typeof item?.text === 'string' ? item.text.trim() : ''))
            .filter(Boolean)
            .join('\n')
          if (text) {
            lastResponse = text
          }
        }
      }
    } catch {}
  }

  return { lastResponse, workState }
}
