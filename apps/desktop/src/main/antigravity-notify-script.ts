// Generates the bash notify hook that the Google Antigravity CLI (`agy`) fires
// for its lifecycle events. Mirrors cursor-notify-script.ts: reads
// ORCHESTRA_ANTIGRAVITY_SESSION_ID from the agent's env, extracts camelCase
// fields (hookEventName, terminationReason, conversationId, toolCall.name) out
// of the JSON payload on stdin, and POSTs to the orchestra localhost listener
// with hard timeouts so the hook can never block agy.
//
// Antigravity expects a JSON object on stdout for every hook event; `{}` is a
// no-op decision on SessionStart, PreInvocation, PreToolUse (ask_question),
// PostToolUse, and Stop, so it is printed first before anything that could fail.
//
// Intentionally dependency-free (curl + grep + sed).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHooksDir } from './orchestra-paths'

export const ANTIGRAVITY_NOTIFY_SCRIPT_NAME = 'antigravity-notify.sh'
export const ANTIGRAVITY_NOTIFY_SCRIPT_MARKER = '# Orchestra-managed antigravity notify hook'

export function getAntigravityNotifyScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHooksDir(env), ANTIGRAVITY_NOTIFY_SCRIPT_NAME)
}

export function buildAntigravityNotifyScript(): string {
  return `#!/bin/bash
${ANTIGRAVITY_NOTIFY_SCRIPT_MARKER}
# Fired by Antigravity hooks (~/.gemini/config/hooks.json). Forwards lifecycle
# events to orchestra over localhost HTTP. Antigravity delivers the payload as
# camelCase JSON on stdin and expects a JSON object on stdout.

printf '{}\\n'
INPUT=$(cat)

[ -z "$ORCHESTRA_ANTIGRAVITY_SESSION_ID" ] && exit 0

# Prefer the live port file rewritten on every app boot; fall back to the env
# port stamped when this PTY spawned.
PORT=$(cat "$(dirname "$0")/../antigravity-hook-port" 2>/dev/null)
case "$PORT" in ''|*[!0-9]*) PORT="$ORCHESTRA_ANTIGRAVITY_HOOK_PORT" ;; esac
[ -z "$PORT" ] && exit 0

EVENT=$(printf '%s' "$INPUT" | grep -oE '"hookEventName"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')

case "$EVENT" in
  SessionStart|PreInvocation|PreToolUse|PostToolUse|Stop) ;;
  *) exit 0 ;;
esac

# Stop carries terminationReason (e.g. NO_TOOL_CALL, USER_CANCELED, ERROR).
# USER_CANCELED is an interrupt, which must not raise a "Finished" notification.
REASON=$(printf '%s' "$INPUT" | grep -oE '"terminationReason"[[:space:]]*:[[:space:]]*"[A-Z0-9_]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
CONVERSATION_ID=$(printf '%s' "$INPUT" | grep -oE '"conversationId"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')

TOOL_NAME=""
if [ "$EVENT" = "PreToolUse" ] || [ "$EVENT" = "PostToolUse" ]; then
  TOOL_NAME=$(printf '%s' "$INPUT" | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
fi

PAYLOAD="{\\"sessionId\\":\\"$ORCHESTRA_ANTIGRAVITY_SESSION_ID\\",\\"event\\":\\"$EVENT\\",\\"terminationReason\\":\\"$REASON\\",\\"conversationId\\":\\"$CONVERSATION_ID\\",\\"toolName\\":\\"$TOOL_NAME\\"}"

curl -s -X POST "http://127.0.0.1:$PORT/antigravity-hook" \\
  --connect-timeout 1 --max-time 2 \\
  -H 'Content-Type: application/json' \\
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
`
}

export function ensureAntigravityNotifyScript(env: NodeJS.ProcessEnv = process.env): {
  path: string
  changed: boolean
} {
  const scriptPath = getAntigravityNotifyScriptPath(env)
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })

  const next = buildAntigravityNotifyScript()
  const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null
  if (existing === next) {
    try { fs.chmodSync(scriptPath, 0o755) } catch {}
    return { path: scriptPath, changed: false }
  }

  fs.writeFileSync(scriptPath, next, { mode: 0o755 })
  return { path: scriptPath, changed: true }
}
