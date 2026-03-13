import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOrchestraBinDir, getOrchestraHooksDir } from './orchestra-paths'

export type CodexHookEventType = 'Start' | 'Stop' | 'PermissionRequest' | 'UserInputRequest'

export const CODEX_HOOK_VERSION = '1'

const NOTIFY_SCRIPT_NAME = 'codex-notify.sh'
const WRAPPER_FILE_NAME = 'codex'
const SESSION_LOG_DIR_NAME = 'codex-sessions'

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

export function getCodexHookRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const binDir = getOrchestraBinDir(env)
  const hooksDir = getOrchestraHooksDir(env)
  const sessionLogDir = path.join(hooksDir, SESSION_LOG_DIR_NAME)
  return {
    binDir,
    hooksDir,
    sessionLogDir,
    notifyScriptPath: path.join(hooksDir, NOTIFY_SCRIPT_NAME),
    codexWrapperPath: path.join(binDir, WRAPPER_FILE_NAME),
  }
}

export function getCodexSessionLogPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const { sessionLogDir } = getCodexHookRuntimePaths(env)
  return path.join(sessionLogDir, `${sessionId}.jsonl`)
}

export function buildCodexNotifyScript(): string {
  return `#!/bin/bash
# Orchestra Codex notification hook

INPUT="$(cat 2>/dev/null || true)"
if [ -z "$INPUT" ] && [ -n "$1" ]; then
  INPUT="$1"
fi

SESSION_ID="\${ORCHESTRA_SESSION_ID:-}"
HOOK_PORT="\${ORCHESTRA_HOOK_PORT:-}"
[ -z "$SESSION_ID" ] && exit 0
[ -z "$HOOK_PORT" ] && exit 0

EVENT_TYPE=$(printf '%s' "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')

case "$EVENT_TYPE" in
  Start|Stop|PermissionRequest|UserInputRequest)
    ;;
  *)
    exit 0
    ;;
esac

curl -sG "http://127.0.0.1:$HOOK_PORT/codex/hook" \\
  --connect-timeout 1 --max-time 2 \\
  --data-urlencode "sessionId=$SESSION_ID" \\
  --data-urlencode "eventType=$EVENT_TYPE" \\
  --data-urlencode "version=\${ORCHESTRA_HOOK_VERSION:-${CODEX_HOOK_VERSION}}" \\
  > /dev/null 2>&1

exit 0
`
}

export function buildCodexWrapperScript(
  wrapperBinDir: string,
  notifyScriptPath: string,
  sessionLogDir: string,
): string {
  const defaultLogPath = `${sessionLogDir}/\${ORCHESTRA_SESSION_ID}.jsonl`

  return `#!/bin/bash
# Orchestra Codex wrapper

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

emit_hook_event() {
  local event_name="$1"
  printf '{"hook_event_name":"%s"}' "$event_name" | bash ${shellQuote(notifyScriptPath)} >/dev/null 2>&1 || true
}

REAL_BIN="$(find_real_binary "codex")"
if [ -z "$REAL_BIN" ]; then
  echo "Orchestra: codex not found in PATH." >&2
  exit 127
fi

if [ -n "$ORCHESTRA_SESSION_ID" ] && [ -f ${shellQuote(notifyScriptPath)} ]; then
  mkdir -p ${shellQuote(sessionLogDir)}
  export CODEX_TUI_RECORD_SESSION=1
  export CODEX_TUI_SESSION_LOG_PATH="\${ORCHESTRA_CODEX_SESSION_LOG_PATH:-${defaultLogPath}}"
  : > "$CODEX_TUI_SESSION_LOG_PATH"

  (
    _orchestra_log="$CODEX_TUI_SESSION_LOG_PATH"
    _orchestra_i=0

    while [ ! -f "$_orchestra_log" ] && [ "$_orchestra_i" -lt 200 ]; do
      _orchestra_i=$((_orchestra_i + 1))
      sleep 0.05
    done
    if [ ! -f "$_orchestra_log" ]; then
      exit 0
    fi

    tail -n 0 -F "$_orchestra_log" 2>/dev/null | while IFS= read -r _orchestra_line; do
      case "$_orchestra_line" in
        *'"type":"event_msg"'*'"payload":{"type":"task_started"'*|*'"type":"event_msg"'*'"payload":{"type":"exec_command_begin"'*|*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*|*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)
          emit_hook_event "Start"
          ;;
        *'"type":"event_msg"'*'"payload":{"type":"task_complete"'*|*'"type":"event_msg"'*'"payload":{"type":"turn_aborted"'*|*'"kind":"codex_event"'*'"msg":{"type":"task_complete"'*|*'"kind":"codex_event"'*'"msg":{"type":"turn_aborted"'*|*'"kind":"codex_event"'*'"msg":{"type":"turn_completed"'*)
          emit_hook_event "Stop"
          ;;
        *'"type":"event_msg"'*'"payload":{"type":"'*'_approval_request"'*|*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)
          emit_hook_event "PermissionRequest"
          ;;
        *'"type":"event_msg"'*'"payload":{"type":"request_user_input"'*|*'"type":"event_msg"'*'"payload":{"type":"user_input_requested"'*|*'"type":"event_msg"'*'"payload":{"type":"tool_user_input_request"'*|*'"kind":"codex_event"'*'"msg":{"type":"request_user_input"'*|*'"kind":"codex_event"'*'"msg":{"type":"user_input_requested"'*|*'"kind":"codex_event"'*'"msg":{"type":"tool_user_input_request"'*)
          emit_hook_event "UserInputRequest"
          ;;
      esac
    done
  ) &
  ORCHESTRA_CODEX_WATCHER_PID=$!
fi

"$REAL_BIN" "$@"
ORCHESTRA_CODEX_STATUS=$?

if [ -n "$ORCHESTRA_CODEX_WATCHER_PID" ]; then
  kill "$ORCHESTRA_CODEX_WATCHER_PID" >/dev/null 2>&1 || true
  wait "$ORCHESTRA_CODEX_WATCHER_PID" 2>/dev/null || true
fi

exit "$ORCHESTRA_CODEX_STATUS"
`
}

export function ensureCodexHookRuntimeInstalled(env: NodeJS.ProcessEnv = process.env): void {
  const paths = getCodexHookRuntimePaths(env)
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.mkdirSync(paths.hooksDir, { recursive: true })
  fs.mkdirSync(paths.sessionLogDir, { recursive: true })

  writeFileIfChanged(paths.notifyScriptPath, buildCodexNotifyScript(), 0o755)
  writeFileIfChanged(
    paths.codexWrapperPath,
    buildCodexWrapperScript(paths.binDir, paths.notifyScriptPath, paths.sessionLogDir),
    0o755,
  )
}
