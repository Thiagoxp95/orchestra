export interface CodexRolloutParseResult {
  lastResponse: string
  workState: 'idle' | 'working' | 'waitingApproval' | 'waitingUserInput'
}

type WorkState = CodexRolloutParseResult['workState']

interface CodexResponseItem {
  type?: unknown
  role?: unknown
  content?: Array<{ text?: unknown }>
  summary?: Array<{ type?: unknown; text?: unknown }>
}

interface CodexEventMsg {
  type?: unknown
  last_agent_message?: unknown
  message?: unknown
  item?: CodexResponseItem
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

function extractTextFromMessageContent(content: unknown): string {
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => (typeof item === 'object' && item && typeof (item as { text?: unknown }).text === 'string'
      ? (item as { text: string }).text.trim()
      : ''))
    .filter(Boolean)
    .join('\n')
}

function extractTextFromReasoningSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return ''

  return summary
    .map((item) => (typeof item === 'object' && item && typeof (item as { text?: unknown }).text === 'string'
      ? (item as { text: string }).text.trim()
      : ''))
    .filter(Boolean)
    .join('\n')
}

function applyEventMessage(
  eventMsg: CodexEventMsg,
  current: CodexRolloutParseResult,
): CodexRolloutParseResult {
  let workState: WorkState = current.workState
  let lastResponse = current.lastResponse
  const eventType = eventMsg.type

  if (eventType === 'task_started' || eventType === 'exec_command_begin') {
    workState = 'working'
  } else if (
    eventType === 'task_complete'
    || eventType === 'turn_aborted'
    || eventType === 'turn_completed'
  ) {
    workState = 'idle'
    const message = eventMsg.last_agent_message
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
    const prompt = extractPromptText(eventMsg)
    if (prompt) {
      lastResponse = prompt
    }
  } else if (eventType === 'agent_message') {
    const message = eventMsg.message
    if (typeof message === 'string' && message.trim()) {
      lastResponse = message.trim()
    }
  } else if (eventType === 'raw_response_item') {
    const item = eventMsg.item

    if (item?.type === 'message' && item.role === 'assistant') {
      const text = extractTextFromMessageContent(item.content)
      if (text) {
        lastResponse = text
      }
    }

    if (item?.type === 'reasoning') {
      const text = extractTextFromReasoningSummary(item.summary)
      if (text) {
        lastResponse = text
      }
    }
  }

  return { workState, lastResponse }
}

export function parseCodexRolloutLines(lines: string[]): CodexRolloutParseResult {
  let result: CodexRolloutParseResult = {
    lastResponse: '',
    workState: 'idle',
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    try {
      const entry = JSON.parse(line)

      if (entry.type === 'event_msg') {
        result = applyEventMessage(entry.payload ?? {}, result)
      } else if (entry.kind === 'codex_event') {
        result = applyEventMessage(entry.payload?.msg ?? {}, result)
      } else if (entry.type === 'response_item' && entry.payload?.type === 'message') {
        const role = entry.payload?.role
        const text = extractTextFromMessageContent(entry.payload?.content)
        if (role === 'assistant' && text) {
          result = { ...result, lastResponse: text }
        }
      }
    } catch {}
  }

  return result
}
