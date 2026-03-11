import * as fs from 'node:fs'

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizePromptHints(promptHints: string[]): string[] {
  const hints: string[] = []
  const seen = new Set<string>()

  for (const promptHint of promptHints) {
    const normalized = normalizePrompt(promptHint)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    hints.push(normalized)
  }

  return hints
}

export function extractClaudeJsonlPromptTexts(entry: any): string[] {
  if (entry?.type !== 'user') return []

  const content = entry?.message?.content
  if (typeof content === 'string') {
    return [content]
  }

  if (!Array.isArray(content)) return []

  const prompts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      prompts.push(item)
      continue
    }

    if (item?.type === 'text' && typeof item.text === 'string') {
      prompts.push(item.text)
    }
  }

  return prompts
}

function readClaudeJsonlPromptTexts(filePath: string): string[] {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const prompts: string[] = []
    const seen = new Set<string>()

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: any
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }

      for (const prompt of extractClaudeJsonlPromptTexts(entry)) {
        const normalized = normalizePrompt(prompt)
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        prompts.push(normalized)
      }
    }

    return prompts
  } catch {
    return []
  }
}

export function doesClaudeJsonlMatchPromptHints(filePath: string, promptHints: string[]): boolean {
  const normalizedHints = normalizePromptHints(promptHints)
  if (normalizedHints.length === 0) return true

  const jsonlPrompts = readClaudeJsonlPromptTexts(filePath)
  if (jsonlPrompts.length === 0) return false

  return jsonlPrompts.some((prompt) => normalizedHints.includes(prompt))
}
