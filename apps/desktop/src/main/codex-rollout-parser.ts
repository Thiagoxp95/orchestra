export interface CodexRolloutParseResult {
  lastResponse: string
  workState: 'idle' | 'working' | 'waitingApproval' | 'waitingUserInput'
}

function extractPromptText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractPromptText(item))
      .filter(Boolean)
      .join('\n')
      .trim()
  }

  if (!value || typeof value !== 'object') {
    return ''
  }

  const obj = value as Record<string, unknown>
  return [
    obj.text,
    obj.message,
    obj.prompt,
    obj.question,
    obj.body,
    obj.description,
    obj.content,
    obj.request,
  ]
    .map((candidate) => extractPromptText(candidate))
    .find(Boolean) ?? ''
}

export function parseCodexRolloutLines(lines: string[]): CodexRolloutParseResult {
  let lastResponse = ''
  let workState: 'idle' | 'working' | 'waitingApproval' | 'waitingUserInput' = 'idle'

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
        ) {
          workState = 'idle'
          const message = entry.payload?.last_agent_message
          if (typeof message === 'string' && message.trim()) {
            lastResponse = message.trim()
          }
        } else if (typeof eventType === 'string' && eventType.endsWith('_approval_request')) {
          workState = 'waitingApproval'
        } else if (
          eventType === 'request_user_input'
          || eventType === 'user_input_requested'
          || eventType === 'tool_user_input_request'
        ) {
          workState = 'waitingUserInput'
          const prompt = extractPromptText(entry.payload)
          if (prompt) {
            lastResponse = prompt
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
