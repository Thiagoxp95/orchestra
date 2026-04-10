# Claude Code Hook-Based Detection — Design

**Date:** 2026-04-09
**Status:** Approved, ready for implementation plan
**Scope:** Complete rewrite of Claude Code session state detection to use Claude Code hooks as the sole source of truth. Adds a one-click install button and first-run nag banner.

## Motivation

Orchestra's current Claude Code detection relies on scanning terminal output buffers (`terminal-output-buffer`), OSC title tracking, and heuristic question/idle detection inside `idle-notifier`. This approach is fragile: recent commits (`ad3557a`, `14a98b7`, `72edf21`) have been fighting false positives and drift between the detector's state and Claude's actual state.

Claude Code exposes a real hook system (`UserPromptSubmit`, `Stop`, `Notification`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, plus others). Using hooks as the contract gives us deterministic state transitions instead of heuristics.

The codebase already anticipates this: `agent-session-types.ts` declares `'claude-hooks'` as a valid authority, and `codex-hook-runtime.ts` provides a battle-tested pattern for a hook runtime (notify script + HTTP endpoint + install routine) we will mirror for Claude.

## Non-Goals

- No Codex changes. The Codex hook runtime is untouched.
- No SDK/stream-json wrapper. Orchestra wraps a user-launched TUI; we can't own the Claude process.
- No uninstall UI. Users who want to remove Orchestra's entries can edit `~/.claude/settings.json` manually.
- No per-workspace hook configuration. Global install only.
- No backup files on disk. Rollback after failed self-test uses an in-memory pre-write copy.

## Architecture Overview

```
Orchestra main process
  ├── claude-hook-runtime.ts       generates + installs ~/.claude/orchestra-hooks/claude-notify.sh
  ├── claude-hook-installer.ts     reads/writes ~/.claude/settings.json safely
  ├── claude-hook-server.ts        HTTP endpoint: GET /claude/hook (on existing Orchestra hook server)
  ├── claude-session-state.ts      state machine: hook events → AgentSessionState
  ├── claude-running-detector.ts   minimal ps-based poll for first-run banner trigger
  └── orchestra-paths.ts           (existing) getOrchestraHooksDir()

Claude Code process (user-spawned inside Orchestra terminal)
  └── on hook event → bash ~/.claude/orchestra-hooks/claude-notify.sh <EventName>
                    └── reads stdin JSON, reads $ORCHESTRA_SESSION_ID + $ORCHESTRA_HOOK_PORT
                    └── curl -G http://127.0.0.1:$PORT/claude/hook
```

**Session matching.** Orchestra already injects `ORCHESTRA_SESSION_ID` and `ORCHESTRA_HOOK_PORT` into the env of every spawned terminal (Codex runtime precedent). Claude Code inherits these, hook subprocesses inherit them, the script reads them from env. The hook's stdin JSON also contains Claude's internal `session_id`, which we track as metadata (it changes on `/clear`). The Orchestra terminal session is the stable primary key.

**Global guard.** The hook script is installed into the user's global `~/.claude/settings.json`, so Claude Code will invoke it for every turn everywhere. The script early-exits in ~1 ms if `ORCHESTRA_SESSION_ID` is absent, so runs outside Orchestra cost ~1 subprocess spawn and nothing else.

## Hook Coverage

Six hooks wired. State machine:

| Hook event | → State | Notes |
|---|---|---|
| `UserPromptSubmit` | `working` | Start of a turn |
| `PreToolUse` | `working` | Heartbeat; self-heals if `UserPromptSubmit` misfires |
| `PostToolUse` | `working` | Still working — tool call done, more may follow |
| `PermissionRequest` | `waitingApproval` | First-class permission signal |
| `Notification` | parse `message`: `"permission"` → `waitingApproval`, `"waiting for input"` → `waitingUserInput`, else no-op | |
| `Stop` | `idle` | End of turn |

All transitions use `authority: 'claude-hooks'`. Sessions without hooks installed stay in `'unknown'` — no fallback authority.

### Stop / Permission race window

Claude Code occasionally emits `Stop` immediately before a `Notification(permission)`. The state machine always accepts transitions in arrival order, so a permission arriving after Stop correctly overrides `idle` → `waitingApproval`.

### Unknown orchestra session

Events with an `orchestraSessionId` that doesn't match any live Orchestra session are dropped silently.

## The Hook Script

**Location:** `~/.claude/orchestra-hooks/claude-notify.sh`

**Properties:**
- Bash, no jq dependency — plain `grep`/`sed` field extraction, matches `codex-notify.sh`.
- Always `exit 0`. A misbehaving hook must never break the user's `claude` turn.
- `curl --connect-timeout 1 --max-time 2` — bounded latency.
- Event type passed as `argv[1]` (what we wire in `settings.json`), not derived from stdin. Avoids spoofing.
- `# version=<CLAUDE_HOOK_VERSION>` comment baked in. `detectClaudeHookInstallState()` parses this.

**Shape:**

```bash
#!/bin/bash
# Orchestra Claude Code hook notifier — version=<CLAUDE_HOOK_VERSION>
set -e

[ -z "$ORCHESTRA_SESSION_ID" ] && exit 0
[ -z "$ORCHESTRA_HOOK_PORT" ] && exit 0

INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0

EVENT_TYPE="${1:-}"
case "$EVENT_TYPE" in
  UserPromptSubmit|PreToolUse|PostToolUse|PermissionRequest|Notification|Stop) ;;
  *) exit 0 ;;
esac

CLAUDE_SESSION_ID=$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
MESSAGE=$(printf '%s' "$INPUT" | grep -oE '"message"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')

curl -sG "http://127.0.0.1:$ORCHESTRA_HOOK_PORT/claude/hook" \
  --connect-timeout 1 --max-time 2 \
  --data-urlencode "orchestraSessionId=$ORCHESTRA_SESSION_ID" \
  --data-urlencode "claudeSessionId=$CLAUDE_SESSION_ID" \
  --data-urlencode "eventType=$EVENT_TYPE" \
  --data-urlencode "message=$MESSAGE" \
  --data-urlencode "version=${ORCHESTRA_HOOK_VERSION:-<CLAUDE_HOOK_VERSION>}" \
  > /dev/null 2>&1 || true

exit 0
```

## Settings.json Entries

Installer appends into `~/.claude/settings.json`, preserving anything else:

```json
"hooks": {
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/orchestra-hooks/claude-notify.sh UserPromptSubmit" }] }],
  "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/orchestra-hooks/claude-notify.sh PreToolUse" }] }],
  "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/orchestra-hooks/claude-notify.sh PostToolUse" }] }],
  "PermissionRequest":[{ "hooks": [{ "type": "command", "command": "bash ~/.claude/orchestra-hooks/claude-notify.sh PermissionRequest" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/orchestra-hooks/claude-notify.sh Notification" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/orchestra-hooks/claude-notify.sh Stop" }] }]
}
```

The literal substring `claude-notify.sh` in any `command` is the detection marker.

## Installer (`claude-hook-installer.ts`)

Pure functions, no Electron imports — unit-testable via vitest.

```ts
type ClaudeHookInstallState =
  | { status: 'not-installed' }
  | { status: 'installed', version: string }
  | { status: 'installed-stale', installedVersion: string, currentVersion: string }
  | { status: 'error', reason: 'settings-malformed' | 'settings-unreadable' | 'script-missing', detail: string }

function detectClaudeHookInstallState(): ClaudeHookInstallState
function installClaudeHooks(): Promise<{ ok: true } | { ok: false, reason: string, detail?: string }>
```

### `detectClaudeHookInstallState()`

1. Stat `~/.claude/orchestra-hooks/claude-notify.sh`. Missing → `not-installed`.
2. Read first ~10 lines of the script, extract `# version=X` comment → `installedVersion`.
3. Read `~/.claude/settings.json`:
   - Missing → `not-installed`.
   - JSON/JSONC parse error → `error: settings-malformed`.
   - IO error → `error: settings-unreadable`.
4. For each of the 6 expected events, check `settings.hooks[EventName]` contains an entry with a `command` string containing `claude-notify.sh`. Any missing → `not-installed`.
5. All present → `installed` (or `installed-stale` if `installedVersion !== CLAUDE_HOOK_VERSION`).

### `installClaudeHooks()`

1. `fs.mkdirSync(hooksDir, { recursive: true })`.
2. `writeFileIfChanged(notifyScriptPath, buildClaudeNotifyScript(), 0o755)`.
3. Read `~/.claude/settings.json` (or `{}` if missing). Keep the raw pre-write string in memory for rollback. On JSON error → return `{ ok: false, reason: 'settings-malformed' }`.
4. Deep-clone parsed JSON. Ensure `hooks[EventName]` arrays exist. For each of the 6 events:
   - If any entry already contains `claude-notify.sh` in its `command`, skip (idempotent).
   - Otherwise append the Orchestra entry.
5. `JSON.stringify(merged, null, 2)` → write to `settings.json.orchestra.tmp` → atomic `fs.renameSync` over `settings.json`.
6. **Self-test:** spawn `claude --debug hooks --print "ping"` with a 5 s timeout. If stderr contains `Invalid settings` (or equivalent hook-disabled marker), restore the pre-write string by writing it back via the same atomic-rename flow, and return `{ ok: false, reason: 'claude-rejected-settings', detail: <stderr tail> }`.
7. Return `{ ok: true }`.

### Auto-update split

- `ensureClaudeHookRuntimeInstalled()` (called at `app.whenReady`, mirrors `ensureCodexHookRuntimeInstalled`) only rewrites the **script file**. Never touches `settings.json`.
- `installClaudeHooks()` (called only from the install button) touches both the script file and `settings.json`.

This split means Orchestra auto-updates the hook script silently (Q4 B) but never silently modifies the user's settings file.

## HTTP Endpoint (`claude-hook-server.ts`)

`GET /claude/hook` registered on the existing Orchestra hook server (same server that serves `/codex/hook`). `GET` matches the `curl -G --data-urlencode` pattern.

Query params: `orchestraSessionId`, `claudeSessionId`, `eventType`, `message`, `version`.

Handler:
1. Validate `orchestraSessionId` is present and matches a live session. Drop silently otherwise.
2. Validate `eventType` is one of the 6 known events. Drop silently otherwise.
3. Call `claudeSessionState.applyHookEvent({ orchestraSessionId, claudeSessionId, eventType, message })`.
4. If `version !== CLAUDE_HOOK_VERSION`, log once per session. Do not reject.
5. Return `204 No Content` regardless of internal result (script doesn't read the body).

## State Machine (`claude-session-state.ts`)

Owns a `Map<orchestraSessionId, ClaudeHookSessionState>`. On each event:

1. Compute next state from the table above.
2. If next state differs from current, emit a `NormalizedAgentSessionStatus` update with `authority: 'claude-hooks'`, bump `lastTransitionAt` and `updatedAt`.
3. Store the latest `claudeSessionId` as metadata (does not trigger a UI update by itself).
4. On `Stop → idle` transition, call `notifyIdleTransition(orchestraSessionId, 'claude', ...)` for the macOS notification + in-app toast. The state has already been resolved, so the notifier does not scan terminal output.

Cleared by `claudeSessionState.onOrchestraSessionClosed(id)` when an Orchestra terminal closes.

## UI Changes

### NavBar button (`NavBar.tsx`)

New `ClaudeHooksButton` inserted between `UsageBadge` and the Skills button (around line 160).

| Install state | Appearance | Click |
|---|---|---|
| `not-installed` | Same style as Skills button. Icon: download/plug. Label: "Install Claude hooks". | Calls `claudeHooks.install()` → toast on success/failure → state re-polls. |
| `installed` / `installed-stale` | Dimmed. Icon: green checkmark. Label: "Hooks installed". `disabled`, `cursor: default`. Tooltip: `Claude Code hooks installed (v<version>)`. | None. |
| `error: settings-malformed` | Red tint. Icon: warning triangle. Label: "Fix settings.json". Tooltip: `Can't install — your ~/.claude/settings.json has a syntax error`. | `shell.openPath('~/.claude/settings.json')`. |

Matches existing button style: `px-1.5 py-0.5 rounded-md text-[10px] font-mono`, `wsColor`-tinted border/background.

### First-run banner (`ClaudeHookInstallBanner.tsx`)

Mounts at top of main content area (above terminal). Renders only when all three are true:

1. `installState.status === 'not-installed'`
2. `hasAnyClaudeRunning === true` (from `claude-running-detector.ts`)
3. Not dismissed this session (in-memory zustand flag, not persisted)

Copy:

> **Install Claude Code hooks** — Orchestra uses Claude Code hooks to track session state (working, idle, needs input). One click installs them to `~/.claude/settings.json`.
> **[Install]**  [Dismiss]

Next app launch re-shows if still not installed. This is intentional.

### Claude-running detector (`claude-running-detector.ts`)

~50 lines. Polls the Orchestra session list every 2 s, runs `ps -o comm= -p <pid>` (or walks children) for each live terminal, sets a boolean `hasAnyClaudeRunning`. Emits to the renderer via IPC. Used solely to gate the banner — no state machine.

### Preload IPC additions (`preload/index.ts`)

```ts
claudeHooks: {
  getState(): Promise<ClaudeHookInstallState>
  install(): Promise<{ ok: boolean; reason?: string; detail?: string }>
  onStateChanged(cb: (state: ClaudeHookInstallState) => void): () => void
  onAnyClaudeRunningChanged(cb: (running: boolean) => void): () => void
}
```

Main process emits `claudeHooks:stateChanged` whenever install completes or the runtime detects a change on window focus.

## Deletion Inventory

**Files fully deleted** (most already gone from working tree):
- `src/main/activity-classifier.ts` + `.test.ts`
- `src/main/terminal-title-tracker.ts` + `.test.ts`
- `src/main/terminal-activity-detector.ts` + `.test.ts`
- `src/main/claude-session-watcher.ts` (the stub no-ops go too)

**Files trimmed:**
- `src/main/idle-notifier.ts` — delete `detectQuestionInText`, `cleanForSummarization`, `looksGarbled`, and the agent-text scanning in `notifyIdleTransition`. Keep the notification dispatch skeleton; it now takes an already-resolved state instead of deriving one.
- `src/main/terminal-output-buffer.ts` — delete `markWorkingStart`, `getAgentResponseText`, `workStartOffset`, and the raw-data-hook machinery if no other consumer remains.
- `src/main/index.ts` — remove Claude watcher init, replace with `ensureClaudeHookRuntimeInstalled()` + hook-server `/claude/hook` route registration.
- `src/shared/agent-session-types.ts` — remove `'claude-watcher-fallback'` from the authority union.

**Files added:**
- `src/main/claude-hook-runtime.ts`
- `src/main/claude-hook-installer.ts`
- `src/main/claude-hook-installer.test.ts`
- `src/main/claude-hook-server.ts` (or extend existing codex hook server file)
- `src/main/claude-session-state.ts`
- `src/main/claude-session-state.test.ts`
- `src/main/claude-running-detector.ts`
- `src/renderer/src/hooks/useClaudeHookInstallState.ts`
- `src/renderer/src/components/ClaudeHooksButton.tsx`
- `src/renderer/src/components/ClaudeHookInstallBanner.tsx`

## Testing Strategy

**Unit (vitest):**
- `claude-hook-installer.test.ts` — settings.json merge, idempotency, existing-tool coexistence (CCNotify hooks present), malformed JSON abort, missing file creates fresh, detect states for all branches.
- `claude-session-state.test.ts` — all 6 event→state transitions, Stop→permission override window, unknown-session drops, authority stamping.

**Manual:**
- Fresh install: click button, verify `~/.claude/orchestra-hooks/claude-notify.sh` exists and is executable, verify `~/.claude/settings.json` has all 6 entries, verify button shows green check.
- Run `claude` inside Orchestra, submit a prompt, verify sidebar shimmer during turn, idle icon after.
- Trigger a permission prompt (`--dangerously-skip-permissions` off), verify `waitingApproval` state.
- Delete the script file, restart Orchestra, verify script is auto-recreated but `settings.json` is untouched.
- Corrupt `settings.json` (add a trailing comma), verify button shows "Fix settings.json" and clicking opens the file.
- Install with CCNotify already wired, verify both tools coexist.
- Run `claude` in a plain Terminal.app (outside Orchestra), verify the hook script early-exits without errors in Claude's debug output.

## Risks & Open Questions

- **Claude Code hook API stability.** The hook event names (`PreToolUse`, `PermissionRequest`, etc.) are the current public surface. If Anthropic renames or removes events, the script keeps working (early-exit on unknown `argv[1]`) but coverage silently degrades. Mitigation: `CLAUDE_HOOK_VERSION` and clear failure signal in the install self-test.
- **`claude --debug hooks` self-test format.** The exact stderr string Claude Code emits for invalid settings may drift across versions. Mitigation: match on multiple known phrases (`Invalid settings`, `hook commands to execute` count mismatch), and if the probe itself fails (binary not on PATH, unexpected output) treat the install as "probably OK, ambiguous" rather than rolling back. Log for diagnosis.
- **Linux/Windows.** Orchestra is Electron, so Linux is in scope. `bash` and `curl` are assumed present. Windows would need a `.ps1` variant — not in this spec, tracked separately.
- **Race on concurrent hook events.** Two hooks can fire within the same millisecond during a tool burst. State machine treats them sequentially by arrival order at the HTTP server; Node's single-threaded handler serializes naturally.
