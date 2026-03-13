// src/main/claude-activity-parser.ts
// Pure functions for parsing Claude Code JSONL activity state.
// Extracted from claude-session-watcher.ts for testability.

export type ClaudeActivityState = 'idle' | 'thinking' | 'tool_executing'

export interface ParseResult {
  lastResponse: string
  activity: ClaudeActivityState
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string')
      ? block.text
      : '')
    .filter(Boolean)
    .join('\n')
}

/**
 * Parse an array of JSONL line strings (already split) to determine
 * Claude's current activity state and last assistant response.
 *
 * Lines are processed from last to first (most recent first).
 */
export function parseJsonlLines(lines: string[]): ParseResult {
  const result: ParseResult = { lastResponse: '', activity: 'idle' }

  let activityDetermined = false
  let responseDetermined = false

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue

    try {
      const entry = JSON.parse(line)

      if (!activityDetermined) {
        // Skip non-activity entry types that don't indicate Claude's state:
        // - 'system': post-turn housekeeping (hook summaries, turn_duration, etc.)
        // - 'file-history-snapshot': file state snapshots
        // - 'queue-operation': internal queue ops
        if (entry.type === 'system' || entry.type === 'file-history-snapshot' ||
            entry.type === 'queue-operation') {
          // Don't set activity — skip to next entry
        } else if (entry.type === 'last-prompt') {
          // 'last-prompt' is written when Claude is ready for the next user input.
          // This is a definitive idle signal — Claude Code sometimes writes the
          // final assistant message with stop_reason: null instead of end_turn,
          // so we can't rely on stop_reason alone.
          result.activity = 'idle'
          activityDetermined = true
        } else if (entry.type === 'progress') {
          // 'progress' with data.type === 'hook_progress' are stop/pre hooks,
          // NOT actual tool execution. Skip them like system entries.
          // Only subagent progress (no hook_progress type) indicates real work.
          const progressType = entry.data?.type
          if (progressType === 'hook_progress') {
            // Post-turn hook — skip, keep scanning
          } else {
            result.activity = 'tool_executing'
            activityDetermined = true
          }
        } else if (entry.type === 'user') {
          const content = entry.message?.content
          const text = extractUserText(content)
          if (text.includes('[Request interrupted by user]')) {
            result.activity = 'idle'
            activityDetermined = true
          } else if (Array.isArray(content) || typeof content === 'string') {
            result.activity = 'thinking'
            activityDetermined = true
          }
        } else if (entry.type === 'assistant') {
          const stopReason = entry.message?.stop_reason
          const content = entry.message?.content
          if (stopReason === 'end_turn') {
            result.activity = 'idle'
            activityDetermined = true
          } else if (
            stopReason === 'tool_use' ||
            (Array.isArray(content) && content.some((b: any) => b.type === 'tool_use'))
          ) {
            result.activity = 'tool_executing'
            activityDetermined = true
          } else if (!stopReason) {
            // Streaming assistant message (no stop_reason yet) = thinking
            result.activity = 'thinking'
            activityDetermined = true
          }
        } else if (entry.type === 'result') {
          // 'result' entries mark the end of a conversation turn
          // If the result has subtype 'success' or 'error', Claude is done
          result.activity = 'idle'
          activityDetermined = true
        }
      }

      if (!responseDetermined && entry.type === 'assistant') {
        const content = entry.message?.content
        if (Array.isArray(content)) {
          const texts: string[] = []
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim())
          }
          if (texts.length > 0) {
            result.lastResponse = texts.join('\n')
            responseDetermined = true
          }
        }
      }

      if (activityDetermined && responseDetermined) break
    } catch {
      continue
    }
  }

  return result
}

/**
 * Determine if a session should show the "working" indicator.
 *
 * IMPORTANT: `claudeActivity` may be `undefined` if no JSONL event has been
 * received yet. We treat undefined as 'idle' — the absence of evidence of
 * activity is NOT evidence of activity.
 */
export function isSessionWorking(
  processStatus: string,
  claudeActivity: ClaudeActivityState | undefined
): boolean {
  if (processStatus === 'claude') {
    // Only show working if we have POSITIVE evidence of activity
    return claudeActivity === 'thinking' || claudeActivity === 'tool_executing'
  }
  return false
}

/**
 * Clean markdown/formatting for sidebar display.
 */
export function cleanForDisplay(response: string): string {
  return response
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 200)
}
