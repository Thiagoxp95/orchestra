/**
 * Renders `claude -p --output-format stream-json` output back to readable text.
 *
 * Automation runs use stream-json so the engines' idle timeout has a liveness
 * signal (text print mode is silent until the run completes). This renderer
 * keeps run history readable: assistant text and tool one-liners are kept,
 * system noise (hooks, thinking-token ticks, tool results) is dropped, and
 * non-JSON lines (shell rc noise, "command not found") pass through verbatim.
 */

export interface ClaudeStreamRenderer {
  /** Feed a raw output chunk; emits rendered text via the onText callback. */
  write(chunk: string): void
  /** Render any trailing partial line — call once when the process exits. */
  flush(): void
}

export function createClaudeStreamRenderer(
  onText: (text: string) => void,
): ClaudeStreamRenderer {
  let buf = ''

  const emitLine = (line: string): void => {
    const text = renderLine(line)
    if (text) onText(text)
  }

  return {
    write(chunk: string): void {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        emitLine(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
      }
    },
    flush(): void {
      if (buf) {
        emitLine(buf)
        buf = ''
      }
    },
  }
}

function renderLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('{')) return line + '\n'

  let evt: { type?: unknown; [key: string]: unknown }
  try {
    evt = JSON.parse(trimmed)
  } catch {
    return line + '\n'
  }
  // JSON without a type field isn't a claude event — keep it visible.
  if (typeof evt.type !== 'string') return line + '\n'

  switch (evt.type) {
    case 'assistant': {
      const message = evt.message as { content?: unknown } | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      const parts: string[] = []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          parts.push(block.text + '\n')
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          parts.push(`⏺ ${block.name}${summarizeToolInput(block.input)}\n`)
        }
      }
      return parts.length ? parts.join('') : null
    }
    case 'result': {
      // On success the result text duplicates the final assistant message.
      if (!evt.is_error) return null
      const detail = typeof evt.result === 'string' && evt.result
        ? evt.result
        : String(evt.subtype ?? 'error')
      return `\n[error] ${detail}\n`
    }
    // system / user (tool results) / rate_limit_event / stream noise
    default:
      return null
  }
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const hint = record.description ?? record.command ?? record.file_path
    ?? record.pattern ?? record.query ?? record.prompt
  if (typeof hint !== 'string' || !hint) return ''
  const oneLine = hint.replace(/\s+/g, ' ').trim()
  return `: ${oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine}`
}
