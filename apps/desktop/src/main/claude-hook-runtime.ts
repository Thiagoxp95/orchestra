// Generates and installs the Claude Code hook notifier script. Mirrors
// codex-hook-runtime.ts but targets Claude's real hook system.
//
// The script lives at ~/.orchestra/hooks/claude-notify.sh and is
// rewritten on every Orchestra startup so its version stays in sync
// with the running build.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraHooksDir } from './orchestra-paths'

export const CLAUDE_HOOK_VERSION = '1'

const NOTIFY_SCRIPT_NAME = 'claude-notify.sh'

export type ClaudeHookEventType =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'

export const CLAUDE_HOOK_EVENT_TYPES: readonly ClaudeHookEventType[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
]

export function getClaudeHookRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const hooksDir = getOrchestraHooksDir(env)
  return {
    hooksDir,
    notifyScriptPath: path.join(hooksDir, NOTIFY_SCRIPT_NAME),
  }
}

export function buildClaudeNotifyScript(): string {
  return `#!/bin/bash
# Orchestra Claude Code hook notifier
# version=${CLAUDE_HOOK_VERSION}
set -e

# Guard: exit silently when not spawned inside an Orchestra session
[ -z "$ORCHESTRA_SESSION_ID" ] && exit 0
[ -z "$ORCHESTRA_HOOK_PORT" ] && exit 0

# Read stdin JSON payload Claude Code supplies to hooks
INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0

# Event type is passed as argv[1] — matches what we wire in settings.json.
# Unknown events exit silently so new Claude Code releases never break us.
EVENT_TYPE="\${1:-}"
case "$EVENT_TYPE" in
  UserPromptSubmit|PreToolUse|PostToolUse|PermissionRequest|Notification|Stop) ;;
  *) exit 0 ;;
esac

# Extract minimal fields without a jq dependency
CLAUDE_SESSION_ID=$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\\1/')
MESSAGE=$(printf '%s' "$INPUT" | grep -oE '"message"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\\1/')

# Fire and forget — bounded latency so hooks never block Claude
curl -sG "http://127.0.0.1:$ORCHESTRA_HOOK_PORT/claude/hook" \\
  --connect-timeout 1 --max-time 2 \\
  --data-urlencode "orchestraSessionId=$ORCHESTRA_SESSION_ID" \\
  --data-urlencode "claudeSessionId=$CLAUDE_SESSION_ID" \\
  --data-urlencode "eventType=$EVENT_TYPE" \\
  --data-urlencode "message=$MESSAGE" \\
  --data-urlencode "version=\${ORCHESTRA_HOOK_VERSION:-${CLAUDE_HOOK_VERSION}}" \\
  > /dev/null 2>&1 || true

exit 0
`
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
  if (existing === content) {
    fs.chmodSync(filePath, mode)
    return
  }
  fs.writeFileSync(filePath, content, { mode })
}

/**
 * Ensure the Claude hook notify script is installed at the canonical path.
 * Does NOT touch ~/.claude/settings.json — that's the installer's job.
 * Safe to call on every app startup.
 */
export function ensureClaudeHookRuntimeInstalled(env: NodeJS.ProcessEnv = process.env): void {
  const paths = getClaudeHookRuntimePaths(env)
  fs.mkdirSync(paths.hooksDir, { recursive: true })
  writeFileIfChanged(paths.notifyScriptPath, buildClaudeNotifyScript(), 0o755)
}

/**
 * Extract the `# version=X` marker from an installed script file.
 * Returns null if the file is missing or has no marker.
 */
export function readInstalledScriptVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const paths = getClaudeHookRuntimePaths(env)
  try {
    const content = fs.readFileSync(paths.notifyScriptPath, 'utf8')
    const match = content.match(/^#\s*version=([^\s]+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}
