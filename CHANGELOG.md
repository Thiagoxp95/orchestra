# Changelog

All notable changes to Orchestra will be documented in this file.

## [0.16.0] - 2026-04-12

### Added
- **Codex app-server integration** — first-class connection to the Codex app-server for authoritative thread state:
  - `CodexAppServerManager` polls `thread/read` per mapped session, applies snapshots to `NormalizedAgentSessionStatus`, and emits only on real transitions
  - Session ↔ thread bidirectional mapping with idempotent `mapSession` / async `unmapSession` (unsubscribes cleanly on teardown)
  - `isSessionAuthoritative()` so consumers can tell whether the app-server is the current source of truth vs. hook fallback
  - Emits `lastResponsePreview` extracted from the latest assistant turn for the sidebar to render
- **Codex remote resume** — `codex-hook-runtime` now rewrites `codex` invocations to `codex resume --remote $ORCHESTRA_CODEX_REMOTE_URL $ORCHESTRA_CODEX_THREAD_ID` when those env vars are set, while preserving user flags and positional prompts
- **Claude heartbeat detector** — extracted `claude-heartbeat-detector` module with transcript-gated end-of-turn synthesis:
  - Only synthesizes a `Stop` when the last JSONL entry is a finished assistant message (text-only blocks, no pending `tool_use`)
  - Injectable deps (timer, fs reader, state peek) so the detector is fully unit-tested without fake clocks or fs fixtures
  - Replaces the old inline debounce in `index.ts` that mis-classified long streaming windows as end-of-turn
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

## [0.15.0] - 2026-04-10

### Added
- **Codex hook-based detection** — matching hook pipeline for Codex sessions:
  - `codex-session-state` machine consuming `Start` / `Stop` / `PermissionRequest` / `UserInputRequest` hook events
  - `/codex/hook` HTTP route on the main-process hook server with param validation
  - `ensureCodexHookRuntimeInstalled()` boot step, status updates forwarded to the renderer via `normalized-agent-state`
  - Idle-notifier integration so Codex sessions fire the same idle/user-input notifications as Claude
  - `get-codex-debug-state` IPC returns real data instead of an empty stub
- **Claude Code hook-based detection** — replaces the old transcript-polling watcher with a first-class integration:
  - Local hook server embedded in the main process, started on boot and coordinated with the daemon via a `hook-port` file
  - `ORCHESTRA_HOOK_PORT` is injected into every spawned terminal so Claude can call back into Orchestra
  - Hook installer that safely merges into `~/.claude/settings.json` with rollback-unlink coverage
  - Generated runtime script with self-test marker and idempotent install
  - State machine for hook events, wired end-to-end from main → IPC → renderer (`normalized-agent-state` channel)
  - Classifies the last assistant message on every `Stop` to detect `needs-input`
  - First-run install banner and navbar install button
- **Granular activity detection** — new pipeline for terminal-level work/idle classification:
  - `terminal-activity-detector` module with content-change tracking and IPC wiring
  - `activity-classifier` integrated with `terminal-title-tracker` so OSC title animation feeds `isTitleAnimating`
  - New `ActivityState` type propagated through IPC and the store
  - Renderer `sessionWorkState` slice and sidebar rendering of granular status

### Changed
- Sidebar renders Claude working state from `normalizedAgentState` (hook-driven), not the old watcher
- Idle notifier accepts a pre-resolved `requiresUserInput` for Claude instead of re-deriving it
- OSC title is now the sole working signal for agent sessions — content changes no longer flip working/idle in OSC mode

### Fixed
- Classify now triggers on every `Stop` (previously lost via `onStatusUpdate`)
- Transcript read retries + heartbeat-based end-of-turn detector eliminate missed transitions
- Local-first classify with `cwd` fallback for transcript discovery
- `Stop` is synthesized on user interrupt (Esc / Ctrl+C) so state resets correctly
- Hook route query-param validation + removed a non-null assertion in main
- `removeAllListeners` now includes `normalized-agent-state`; top-level type import restored
- `useNormalizedAgentState` guards Codex explicitly before falling back to hardcoded authority
- Idle notification and user-input detection restored on idle transitions
- Claude session state permission match tightened; dead code removed
- Dead `claudeInterruptHint` IPC path removed

### Removed
- `claude-session-watcher` and the `claude-watcher-fallback` authority — fully replaced by the hook runtime
- Old activity-detection files, IPC channels, renderer listeners, and session-watcher hooks
- Unused raw-data-hook machinery in `terminal-output-buffer`

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
