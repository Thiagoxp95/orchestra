import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraBinDir, getOrchestraHooksDir } from './orchestra-paths'

export type ClaudeHookEventType = 'Start' | 'Stop' | 'PermissionRequest'

export const CLAUDE_HOOK_VERSION = '2'

const NOTIFY_SCRIPT_NAME = 'claude-notify.sh'
const SETTINGS_FILE_NAME = 'claude-settings.json'
const WRAPPER_FILE_NAME = 'claude'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
  if (existing === content) {
    fs.chmodSync(filePath, mode)
    return
  }

  fs.writeFileSync(filePath, content, { mode })
}

export function getClaudeHookRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const binDir = getOrchestraBinDir(env)
  const hooksDir = getOrchestraHooksDir(env)
  return {
    binDir,
    hooksDir,
    notifyScriptPath: path.join(hooksDir, NOTIFY_SCRIPT_NAME),
    claudeSettingsPath: path.join(hooksDir, SETTINGS_FILE_NAME),
    claudeWrapperPath: path.join(binDir, WRAPPER_FILE_NAME),
  }
}

export function buildClaudeSettingsContent(notifyScriptPath: string): string {
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: notifyScriptPath }] }],
      Stop: [{ hooks: [{ type: 'command', command: notifyScriptPath }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: notifyScriptPath }] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: notifyScriptPath }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: notifyScriptPath }] }],
    },
  })
}

export function buildClaudeNotifyScript(): string {
  return `#!/bin/bash
# Orchestra Claude notification hook

INPUT=$(cat)
SESSION_ID="\${ORCHESTRA_SESSION_ID:-}"
[ -z "$SESSION_ID" ] && exit 0
HOOK_PORT="\${ORCHESTRA_HOOK_PORT:-}"
[ -z "$HOOK_PORT" ] && exit 0

ORIGINAL_EVENT=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')

case "$ORIGINAL_EVENT" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure)
    EVENT_TYPE="Start"
    ;;
  Stop)
    EVENT_TYPE="Stop"
    ;;
  PermissionRequest)
    EVENT_TYPE="PermissionRequest"
    ;;
  *)
    exit 0
    ;;
esac

# Extract user_message from UserPromptSubmit events for notification titles
USER_MSG=""
if [ "$ORIGINAL_EVENT" = "UserPromptSubmit" ]; then
  USER_MSG=$(echo "$INPUT" | sed -n 's/.*"user_message"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1 | head -c 300)
fi

curl -sG "http://127.0.0.1:$HOOK_PORT/claude/hook" \\
  --connect-timeout 1 --max-time 2 \\
  --data-urlencode "sessionId=$SESSION_ID" \\
  --data-urlencode "eventType=$EVENT_TYPE" \\
  --data-urlencode "version=\${ORCHESTRA_HOOK_VERSION:-${CLAUDE_HOOK_VERSION}}" \\
  --data-urlencode "userMessage=$USER_MSG" \\
  > /dev/null 2>&1

exit 0
`
}

export function buildClaudeWrapperScript(
  wrapperBinDir: string,
  claudeSettingsPath: string,
): string {
  return `#!/bin/bash
# Orchestra Claude wrapper

find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      ${shellQuote(wrapperBinDir)}) continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf "%s\\n" "$dir/$name"
      return 0
    fi
  done
  return 1
}

REAL_BIN="$(find_real_binary "claude")"
if [ -z "$REAL_BIN" ]; then
  echo "Orchestra: claude not found in PATH." >&2
  exit 127
fi

exec "$REAL_BIN" --settings ${shellQuote(claudeSettingsPath)} "$@"
`
}

export function ensureClaudeHookRuntimeInstalled(env: NodeJS.ProcessEnv = process.env): void {
  const paths = getClaudeHookRuntimePaths(env)
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.mkdirSync(paths.hooksDir, { recursive: true })

  writeFileIfChanged(paths.notifyScriptPath, buildClaudeNotifyScript(), 0o755)
  writeFileIfChanged(paths.claudeSettingsPath, buildClaudeSettingsContent(paths.notifyScriptPath), 0o644)
  writeFileIfChanged(
    paths.claudeWrapperPath,
    buildClaudeWrapperScript(paths.binDir, paths.claudeSettingsPath),
    0o755,
  )
}
