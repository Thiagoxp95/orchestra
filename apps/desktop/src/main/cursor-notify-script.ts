// Generates the bash notify hook that the Cursor CLI (`agent`) fires for its
// lifecycle events. Mirrors codex-notify-script.ts: the script reads
// ORCHESTRA_CURSOR_SESSION_ID from the agent's env, pulls the event name, the
// stop status and cursor's conversation id out of the JSON payload on stdin,
// and POSTs `{sessionId, event, status?, conversationId?}` to the orchestra
// localhost listener with hard timeouts so the hook can never block cursor.
//
// Unlike claude/codex, cursor reads the hook's STDOUT as its decision (continue
// the prompt, allow the tool). `{}` means "no opinion" — measured against
// cursor 2026.09.10 it lets prompts and tools through under --force and leaves
// cursor's own approval prompts in charge otherwise — so it is printed first,
// on every path, before anything that could fail.
//
// Intentionally dependency-free (curl + grep + sed).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHooksDir } from './orchestra-paths'

export const CURSOR_NOTIFY_SCRIPT_NAME = 'cursor-notify.sh'
export const CURSOR_NOTIFY_SCRIPT_MARKER = '# Orchestra-managed cursor notify hook'

export function getCursorNotifyScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHooksDir(env), CURSOR_NOTIFY_SCRIPT_NAME)
}

export function buildCursorNotifyScript(): string {
  return `#!/bin/bash
${CURSOR_NOTIFY_SCRIPT_MARKER}
# Fired by cursor hooks (~/.cursor/hooks.json). Forwards the event type to
# orchestra over localhost HTTP. Cursor delivers the payload as JSON on stdin
# and reads a JSON decision from stdout.

printf '{}\\n'
INPUT=$(cat)

[ -z "$ORCHESTRA_CURSOR_SESSION_ID" ] && exit 0

# Same port-staleness rule as claude-notify.sh: the env port dies with the app
# run that spawned this PTY; the file is the current app's live port.
PORT=$(cat "$(dirname "$0")/../cursor-hook-port" 2>/dev/null)
case "$PORT" in ''|*[!0-9]*) PORT="$ORCHESTRA_CURSOR_HOOK_PORT" ;; esac
[ -z "$PORT" ] && exit 0

EVENT=$(printf '%s' "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')

case "$EVENT" in
  sessionStart|beforeSubmitPrompt|preToolUse|postToolUse|stop) ;;
  *) exit 0 ;;
esac

# stop carries status: completed | aborted | error. aborted is an interrupt,
# which must not raise a "Finished" notification.
STATUS=$(printf '%s' "$INPUT" | grep -oE '"status"[[:space:]]*:[[:space:]]*"[a-z_]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
CONVERSATION_ID=$(printf '%s' "$INPUT" | grep -oE '"conversation_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')

PAYLOAD="{\\"sessionId\\":\\"$ORCHESTRA_CURSOR_SESSION_ID\\",\\"event\\":\\"$EVENT\\",\\"status\\":\\"$STATUS\\",\\"conversationId\\":\\"$CONVERSATION_ID\\"}"

curl -s -X POST "http://127.0.0.1:$PORT/cursor-hook" \\
  --connect-timeout 1 --max-time 2 \\
  -H 'Content-Type: application/json' \\
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
`
}

export function ensureCursorNotifyScript(env: NodeJS.ProcessEnv = process.env): {
  path: string
  changed: boolean
} {
  const scriptPath = getCursorNotifyScriptPath(env)
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })

  const next = buildCursorNotifyScript()
  const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null
  if (existing === next) {
    try { fs.chmodSync(scriptPath, 0o755) } catch {}
    return { path: scriptPath, changed: false }
  }

  fs.writeFileSync(scriptPath, next, { mode: 0o755 })
  return { path: scriptPath, changed: true }
}
