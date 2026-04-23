// apps/desktop/src/main/claude-jsonl-prompts.ts
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

function extractTextFromEntry(entry: any): string | null {
  if (entry?.type !== 'user') return null
  const content = entry?.message?.content

  if (typeof content === 'string') {
    const cleaned = stripSystemReminders(content)
    return cleaned.length > 0 ? cleaned : null
  }

  if (!Array.isArray(content)) return null

  const textParts: string[] = []
  for (const item of content) {
    if (item?.type === 'tool_result') return null
    if (typeof item === 'string') textParts.push(item)
    else if (item?.type === 'text' && typeof item.text === 'string') textParts.push(item.text)
  }
  if (textParts.length === 0) return null
  const cleaned = stripSystemReminders(textParts.join('\n'))
  return cleaned.length > 0 ? cleaned : null
}

export function extractLastUserPrompt(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    const text = extractTextFromEntry(entry)
    if (text) return text
  }
  return null
}
