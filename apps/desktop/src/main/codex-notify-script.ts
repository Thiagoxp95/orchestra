// Generates the bash notify hook that codex fires for SessionStart /
// UserPromptSubmit / Stop. The script reads ORCHESTRA_CODEX_SESSION_ID and
// ORCHESTRA_CODEX_HOOK_PORT from the codex process env, parses the event type
// out of the JSON payload codex passes (stdin for hooks; first arg for the
// `notify=[...]` callback), and POSTs `{sessionId, event}` to the orchestra
// localhost listener with hard timeouts so the hook can never block codex.
//
// The generated script is intentionally dependency-free (curl + grep + sed).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHooksDir } from './orchestra-paths'

export const CODEX_NOTIFY_SCRIPT_NAME = 'codex-notify.sh'
export const CODEX_NOTIFY_SCRIPT_MARKER = '# Orchestra-managed codex notify hook'

export function getCodexNotifyScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOrchestraHooksDir(env), CODEX_NOTIFY_SCRIPT_NAME)
}

export function buildCodexNotifyScript(): string {
  return `#!/bin/bash
${CODEX_NOTIFY_SCRIPT_MARKER}
# Fired by codex hooks (~/.codex/hooks.json) and the codex \`notify=[...]\`
# callback. Forwards the event type to orchestra over localhost HTTP.

[ -z "$ORCHESTRA_CODEX_SESSION_ID" ] && exit 0
[ -z "$ORCHESTRA_CODEX_HOOK_PORT" ] && exit 0

if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

# Codex hooks (~/.codex/hooks.json) deliver "hook_event_name". The codex CLI's
# \`notify=[...]\` callback delivers "type". Try both, keep the first match.
EVENT=$(printf '%s' "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
if [ -z "$EVENT" ]; then
  CODEX_TYPE=$(printf '%s' "$INPUT" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\\1/')
  case "$CODEX_TYPE" in
    agent-turn-complete|task_complete) EVENT="Stop" ;;
    task_started)                      EVENT="UserPromptSubmit" ;;
  esac
fi

# Only forward events orchestra cares about.
case "$EVENT" in
  SessionStart|UserPromptSubmit|Stop) ;;
  *) exit 0 ;;
esac

PAYLOAD="{\\"sessionId\\":\\"$ORCHESTRA_CODEX_SESSION_ID\\",\\"event\\":\\"$EVENT\\"}"

curl -s -X POST "http://127.0.0.1:$ORCHESTRA_CODEX_HOOK_PORT/codex-hook" \\
  --connect-timeout 1 --max-time 2 \\
  -H 'Content-Type: application/json' \\
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
`
}

export function ensureCodexNotifyScript(env: NodeJS.ProcessEnv = process.env): {
  path: string
  changed: boolean
} {
  const scriptPath = getCodexNotifyScriptPath(env)
  const dir = path.dirname(scriptPath)
  fs.mkdirSync(dir, { recursive: true })

  const next = buildCodexNotifyScript()
  const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null
  if (existing === next) {
    try { fs.chmodSync(scriptPath, 0o755) } catch {}
    return { path: scriptPath, changed: false }
  }

  fs.writeFileSync(scriptPath, next, { mode: 0o755 })
  return { path: scriptPath, changed: true }
}
