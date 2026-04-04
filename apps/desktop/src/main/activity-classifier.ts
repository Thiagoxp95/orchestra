// apps/desktop/src/main/activity-classifier.ts
// Pure-function classifier that pattern-matches terminal buffer content
// to determine granular activity sub-state. Returns null if no pattern matches.

import type { ActivityState } from '../shared/types'

const SCAN_TAIL = 300 // only scan the last N chars of the buffer

const SPINNER_CHARS = '[✢✳✶✻✽*·⠂⠐]'

const THINKING_VERBS = [
  'Thinking', 'Pondering', 'Contemplating', 'Reasoning', 'Cogitating',
  'Synthesizing', 'Reflecting', 'Analyzing', 'Processing', 'Computing',
  'Considering', 'Evaluating', 'Formulating', 'Imagining', 'Brainstorming',
  'Architecting', 'Assembling', 'Brewing', 'Calculating', 'Crafting',
]

const TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Agent', 'Search', 'NotebookEdit',
  'TodoWrite', 'TodoRead',
]

// Past-tense verbs used by Claude Code for turn completion
const COMPLETION_VERBS = [
  'Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked',
  'Crunched', 'Saut[eé]ed', 'Worked', 'Crafted', 'Built',
  'Computed', 'Processed', 'Synthesized', 'Assembled',
]

const INTERRUPTED_RE = /Interrupted/
const PERMISSION_RE = /\b(Yes|Allow)\s+(No|Deny)\b/i
const THINKING_RE = new RegExp(`${SPINNER_CHARS}\\s*(${THINKING_VERBS.join('|')})`)
const TOOL_RE = new RegExp(`${SPINNER_CHARS}\\s*(${TOOL_NAMES.join('|')})\\b`)
const COMPLETION_RE = new RegExp(`(${COMPLETION_VERBS.join('|')})\\s+for\\s+\\d+(\\.\\d+)?s`)

export function classifyActivity(buffer: string): Exclude<ActivityState, 'idle' | 'working' | 'stalled'> | null {
  if (!buffer) return null

  const tail = buffer.length > SCAN_TAIL ? buffer.slice(-SCAN_TAIL) : buffer

  // Priority 1: Interrupted
  if (INTERRUPTED_RE.test(tail)) return 'interrupted'

  // Priority 2: Permission request
  if (PERMISSION_RE.test(tail)) return 'permission_request'

  // Priority 3: Thinking (check before tool_executing since both use spinner chars)
  if (THINKING_RE.test(tail)) return 'thinking'

  // Priority 4: Tool executing
  if (TOOL_RE.test(tail)) return 'tool_executing'

  // Priority 5: Turn complete
  if (COMPLETION_RE.test(tail)) return 'turn_complete'

  return null
}
