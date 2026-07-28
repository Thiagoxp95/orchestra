// Generates the bash notify hook that Claude fires for its lifecycle events
// (UserPromptSubmit / Pre|PostToolUse / PermissionRequest / Stop / Subagent*).
// The script reads ORCHESTRA_CLAUDE_SESSION_ID and ORCHESTRA_CLAUDE_HOOK_PORT
// from the Claude process env, parses the event name plus a few decision
// fields out of the JSON payload Claude passes on stdin, and POSTs
// `{sessionId, event, toolName?, isInterrupt?, agentId?, agentType?}` to the
// orchestra localhost listener with hard timeouts so the hook can never block
// Claude. All event→state mapping lives in claude-notify-listener.ts (testable
// TypeScript) — this script only forwards raw fields.
//
// Mirrors codex-notify-script.ts. Intentionally dependency-free (curl + grep +
// sed) and safe to fire on every tool call: it exits early (before curl) for
// any Claude session that orchestra didn't launch.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHooksDir } from './orchestra-paths'

export const CLAUDE_NOTIFY_SCRIPT_NAME = 'claude-notify.sh'
export const CLAUDE_NOTIFY_SCRIPT_MARKER = '# Orchestra-managed claude notify hook'

export function getClaudeNotifyScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHooksDir(env), CLAUDE_NOTIFY_SCRIPT_NAME)
}

export function buildClaudeNotifyScript(): string {
  return `#!/bin/bash
${CLAUDE_NOTIFY_SCRIPT_MARKER}
# Fired by Claude hooks (~/.claude/settings.json). Forwards the event type and a
# few decision fields to orchestra over localhost HTTP. Claude delivers the hook
# payload as JSON on stdin.

[ -z "$ORCHESTRA_CLAUDE_SESSION_ID" ] && exit 0
[ -z "$ORCHESTRA_CLAUDE_HOOK_PORT" ] && exit 0

INPUT=$(cat)

EVENT=$(printf '%s' "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')

# Only forward events orchestra consumes — a state mapping, or SessionStart,
# which exists purely to report transcript_path the moment claude launches
# (before any prompt fires the other hooks). Unknown/unregistered events
# (older or newer Claude builds) are ignored.
case "$EVENT" in
  SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure|PermissionRequest|Stop|StopFailure|SubagentStart|SubagentStop|TeammateIdle) ;;
  *) exit 0 ;;
esac

# tool_name distinguishes an AskUserQuestion (→ waitingUserInput) from an
# ordinary tool (→ working). agent_id/agent_type identify subagent-origin
# events so the listener keeps a pane working while background children run.
TOOL_NAME=$(printf '%s' "$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
AGENT_ID=$(printf '%s' "$INPUT" | grep -oE '"agent_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
AGENT_TYPE=$(printf '%s' "$INPUT" | grep -oE '"agent_type"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
# is_interrupt is a JSON boolean, not a string — capture true/false directly.
IS_INTERRUPT=$(printf '%s' "$INPUT" | grep -oE '"is_interrupt"[[:space:]]*:[[:space:]]*(true|false)' | head -n 1 | sed -E 's/.*:[[:space:]]*//')
# transcript_path pairs this orchestra session with the JSONL Claude is writing.
# Claude's own session id differs from ours and appears nowhere else, so without
# this the only way to find the transcript is to guess by working directory.
# Sent raw: the value is an absolute path from Claude itself, and the payload
# below is assembled by string concatenation, so a path containing a quote or a
# backslash would produce invalid JSON — dropped rather than risk that.
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | grep -oE '"transcript_path"[[:space:]]*:[[:space:]]*"[^"\\\\]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')

PAYLOAD="{\\"sessionId\\":\\"$ORCHESTRA_CLAUDE_SESSION_ID\\",\\"event\\":\\"$EVENT\\",\\"toolName\\":\\"$TOOL_NAME\\",\\"agentId\\":\\"$AGENT_ID\\",\\"agentType\\":\\"$AGENT_TYPE\\",\\"isInterrupt\\":\\"$IS_INTERRUPT\\",\\"transcriptPath\\":\\"$TRANSCRIPT_PATH\\"}"

curl -s -X POST "http://127.0.0.1:$ORCHESTRA_CLAUDE_HOOK_PORT/claude-hook" \\
  --connect-timeout 1 --max-time 2 \\
  -H 'Content-Type: application/json' \\
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
`
}

export function ensureClaudeNotifyScript(env: NodeJS.ProcessEnv = process.env): {
  path: string
  changed: boolean
} {
  const scriptPath = getClaudeNotifyScriptPath(env)
  const dir = path.dirname(scriptPath)
  fs.mkdirSync(dir, { recursive: true })

  const next = buildClaudeNotifyScript()
  const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null
  if (existing === next) {
    try { fs.chmodSync(scriptPath, 0o755) } catch {}
    return { path: scriptPath, changed: false }
  }

  fs.writeFileSync(scriptPath, next, { mode: 0o755 })
  return { path: scriptPath, changed: true }
}
