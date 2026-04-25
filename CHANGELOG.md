# Changelog

All notable changes to Orchestra will be documented in this file.

## [1.2.0] - 2026-04-25

### Added
- **Codex hooks pipeline** — replaces the polled app-server with a push model:
  - `~/.codex/hooks.json` registered idempotently on startup, preserving user/foreign hook entries
  - `~/.orchestra/hooks/codex-notify.sh` POSTs UserPromptSubmit / Stop events to a localhost listener
  - `CodexNotifyListener` translates events into `NormalizedAgentSessionStatus` updates with `authority: 'codex-hook'`
  - Legacy `~/.orchestra*/bin/codex` wrapper artifacts are detected and removed on launch
  - Codex interrupted-prompt detection in the daemon-client routes through `idle-notifier` as `wasInterrupted`
- **Usage manager rewrite (ClaudeBar parity)** — mirrors the QuotaMonitor architecture:
  - Per-provider `isSyncing` state with in-flight dedup of concurrent refreshes
  - Background sync settings persisted via electron-store (off by default, 60s when enabled, 30s minimum)
  - Hover-triggered refresh on the footer badge with a 2s minimum interval
  - Cold-start retry (one-shot, 20s) so the very first Claude probe failure no longer hides Claude until hover
  - `refreshUsage(providerId?)` lets callers refresh a single provider
- **Pre-formatted reset text** — probes emit `RateWindow.resetText` so the panel can render `"Resets in 2d 4h"` without recomputing, with a live countdown layered on top via `formatResetText`
- New tests: `headless-emulator`, `codex-hooks-setup`, `codex-notify-listener`, `codex-notify-script`, `codex-terminal-state`, `idle-notifier-interruption`, `process-monitor`, `updater`, `usage-manager`, `UsageBadge`, `terminal-responses`

### Changed
- `usage-manager` no longer schedules a periodic 15-minute Claude probe and no longer applies client-side 429 backoff — errors surface in the snapshot instead, and the user can retry whenever they want
- `daemon-client` drops the LLM `prompt-summarizer` dependency for session labels — now uses the trimmed prompt directly, removing a per-prompt API round-trip
- `updater` registers IPC handlers idempotently and clears them on `stopUpdater`, fixing duplicate-handler warnings on re-init
- `node-runtime` PATH ordering: the user's own `$PATH` now wins over orchestra's user-binary fallbacks (`~/.bun/bin`, `~/.local/bin`, …), restoring parity with the native shell when multiple copies of a CLI are installed
- `process-monitor`: `ps` snapshot uses a 32 MB buffer (busy dev Macs were truncating at 1 MB and dropping every agent into the null-table branch), and a failed snapshot now preserves the previous status instead of mass-flipping every agent session to `terminal`
- `agent-session-types`: `'codex-hook'` is the new authority for codex sessions; `'codex-app-server'` and `'codex-watcher-fallback'` are kept for type compatibility with in-flight statuses

### Removed
- **Last-user-message banner** — the entire feature is retired:
  - `LastMessageBanner.tsx`, `claude-jsonl-prompts`, `claude-transcript-tail`, `last-user-message-store`, `lastMessageStore`, and the `session:last-user-message` IPC channel
- **Codex polled pipeline** — replaced by the hooks listener:
  - `codex-app-server`, `codex-app-server-manager`, `codex-rollout-files`, `codex-rollout-parser`, `codex-rollout-tail`, `codex-session-watcher`, `codex-thread-state`, `codex-watch-registration`
- **Client-side 429 backoff** — `usage-cooldown` and `UsageProbeResult.cooldownUntil` are gone now that the manager does no automatic re-probing

## [1.0.0] - 2026-04-23

### Added
- **Last-user-message banner** — new banner above the terminal pane that surfaces the most recent user prompt for Claude and Codex sessions:
  - Claude transcript jsonl tailer with mixed text + tool_result array handling
  - Codex rollout file tailer wired into the main process
  - IPC bridge for last-user-message events and renderer subscription
  - Central last-user-message store with broadcast to all windows
  - `LastMessageBanner` React component rendered above the terminal pane
- **Claude / Codex usage probes** — dedicated probes that lean on the official CLI paths, plus Claude OAuth credential support
- **Terminal notification parser** — extracts structured notifications from terminal output
- Workspace-scoped `.orchestra/workspace-settings.json` and a `/desktop:dev` slash command for local iteration

### Changed
- Usage-probe simplified to rely on the official CLI paths instead of bespoke parsing
- Cleaned up legacy layers: removed claude/codex session-watcher, hook-runtime, hook-server, hook-port-file, claude-session-state, codex-session-state, claude-running-detector, claude-transcript-reader, claude-jsonl-matcher, `ClaudeHookInstallBanner`, `ClaudeHooksButton`, `useClaudeHookInstallState`, and `useNormalizedAgentState` — the banner + app-server pipeline make them redundant
- Archived completed design docs (idle-notification, claude-hooks-detection, agent-state-authority, granular-activity-detection, terminal-content-change-detection)

## [0.16.0] - 2026-04-12

### Added
- **Codex app-server integration** — first-class connection to the Codex app-server for authoritative thread state:
  - `CodexAppServerManager` polls `thread/read` per mapped session, applies snapshots to `NormalizedAgentSessionStatus`, and emits only on real transitions
  - Session ↔ thread bidirectional mapping with idempotent `mapSession` / async `unmapSession` (unsubscribes cleanly on teardown)
  - `isSessionAuthoritative()` so consumers can tell whether the app-server is the current source of truth
  - Emits `lastResponsePreview` extracted from the latest assistant turn for the sidebar to render
- **Sidebar attention-based sorting** — new `sortSessionsForSidebar` utility ranks sessions by their normalized agent state so `waitingUserInput` / `waitingApproval` sessions bubble to the top
- **Codex sidebar states** — tree-level Codex action state reports `waitingUserInput` / `waitingApproval` from `normalizedAgentState`
- `isSuspended` field on `SessionInfo` / `Session.getMeta()` so the protocol surfaces suspended sessions
- `isCodexInteractiveInitialCommand()` shared helper for classifying Codex interactive commands across warm-agent and session code

### Changed
- Sidebar agent-response preview prefers `normalizedAgentState.lastResponsePreview` over the per-agent `claudeLastResponse` / `codexLastResponse` channels
- Warm-agent pool now supports Claude only — Codex warm agents were removed because remote-resume makes the pre-warm path redundant and was racing with thread mapping
- `CodexAppServerManager` constructor now takes `{ onStatusUpdate, client, pollIntervalMs }` for dependency injection and testability
- `createThread` immediately unsubscribes from notification stream after capturing the initial snapshot — polling is authoritative, notifications were duplicative

### Fixed
- Session polling no longer overlaps itself (`pollInFlight` guard) and stops automatically when the last session unmaps
- Remapping a session to a new thread now cleans up the old `threadToSession` entry instead of leaking it
- Initial idle snapshots with no response preview no longer emit a spurious status update

## [0.9.2] - 2026-03-25

### Changed
- Replaced webhook HTTP polling with real-time Convex WebSocket subscriptions — lower latency, less network overhead, and simplified event processing with stale-event detection and deduplication

### Fixed
- False idle detection during active Claude streaming — now detects streaming indicators between last work character and prompt
- Rapid-fire duplicate webhook actions from services like Linear — added 30s action-level debounce

## [0.9.1] - 2026-03-24

### Fixed
- Release workflow now reconciles checksums from uploaded assets to handle upload corruption, fixing auto-update failures since v0.7.0

### Changed
- Redesigned UpdateCard in sidebar — cleaner layout with accent stripe, contextual icons, and streamlined actions

## [0.9.0] - 2026-03-24

### Added
- **Linear Board View** — full kanban board integration with Linear project management
  - GraphQL client for Linear API with typed queries
  - Encrypted API key storage via Electron safeStorage IPC
  - `useLinearBoard` hook with polling and local caching
  - `LinearTicketCard` component with status indicators
  - `LinearDetailPanel` for viewing issue details inline
  - `LinearBoard` kanban component with drag-and-drop between columns
  - View mode toggle in sidebar to switch between terminal and board views
  - Linear configuration page in workspace settings
  - Workspace-level `viewMode` and `linearConfig` in store and shared types
- **EmojiPicker** component for workspace customization
- Idle notifier and usage tracking UI refinements

### Changed
- SettingsDialog wired with Linear configuration props
- App conditionally renders LinearBoard or TerminalArea based on workspace view mode

## [0.4.0] - 2026-03-19

### Added
- Warm agent pool — pre-spawn Claude/Codex agents for near-instant session startup
- Agent session aliases — decouple display session IDs from process session IDs so warm agents can be claimed without visible ID changes
- Terminal query responder — synthetic DA1/DA2/DSR/OSC replies so TUI apps bootstrap correctly before a real PTY attaches
- Webhook management UI in AddActionDialog — enable/disable webhooks, generate tokens, configure filters, and copy webhook URLs inline
- Sidebar agent response sanitizer — strip box-drawing, junk lines, and terminal artifacts from sidebar previews
- Garbled-text detection in idle notifications — skip summarization for mangled prompts

### Changed
- Removed WebGL addon from terminal renderer — fall back to canvas for broader compatibility
- Broadened terminal response stripping regex to catch OSC color reports, focus events, and cursor position replies
- Codex rollout parser now handles array-of-content-blocks responses (output_text items)
- Idle notifier shows short prompts verbatim instead of calling the summarizer
- Idle notifier detects requiresUserInput from agent response even when no user prompt is available
- Worktree deletion now always removes from store on force-delete, even if disk cleanup fails
- Terminal cursor uses block style when inactive with proper cursorAccent color
- Warm shell pool adds exponential backoff on spawn failures to prevent respawn storms

### Fixed
- Worktree force-delete no longer shows an error alert when the user explicitly chose "Delete Anyway"

## [0.3.0] - 2026-03-19

### Added
- Webhook toast notifications with expandable detail view (dev-only)
- Webhook event filtering with filterPrompt and filterResult support
- Warm shell pool for faster session startup
- Hidden input echo filter for cleaner terminal output
- Terminal output buffer for improved rendering performance
- Sidebar session ordering (most recent first)
- User prompt tracking in maestro sessions
- Grid navigation in maestro pane
- Git worktree scanning for workspace discovery
- Maestro pane tree labels, status text, and scrollbar styling
- Exec launch profiles for Claude and Codex agents
- Project README with getting started guide

### Changed
- Replaced hardcoded Convex URLs with environment-based configuration
- Improved startup idle timer and Codex PATH resolution
- Release artifact retention reduced to 1 day to prevent quota buildup

## [0.2.0] - 2026-03-14

Initial tagged release.
