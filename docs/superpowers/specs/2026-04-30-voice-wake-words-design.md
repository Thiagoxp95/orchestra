# Voice Wake Words for Footer Actions — Design

**Status:** Approved (brainstorming complete, ready for implementation plan)
**Date:** 2026-04-30
**Scope:** macOS-first, opt-in feature in Orchestra desktop app

## Goal

Let users invoke footer custom actions hands-free by saying a wake word followed by an action name — e.g. "computer ... ship" runs the workspace's "Ship" action. Visual feedback in the footer shows when the app is listening, what it heard, and which action ran.

## Non-Goals (v1)

- Cross-platform support. macOS-only initially; Windows/Linux deferred.
- Voice control of `AgentFooterControls` dropdowns (Approvals, model picker, etc.).
- Global verbs ("Maestro", "Settings", "Skills") — footer custom actions only.
- Streaming partial transcripts. Single-shot transcribe per command.
- Chained commands. Each command requires a fresh wake-word.
- Custom-trained "Orchestra" wake word. v1 uses prebuilt openWakeWord models; "Orchestra" wake word is a future spec.
- Background voice when app is fully quit. No menu-bar daemon. (Listening continues when the app is minimized or hidden — only a full quit stops it.)

## User Experience

### Activation pattern

Two-step ("classic Siri"):
1. Wake word "computer" is detected → footer mic indicator pulses.
2. User says the action name within 5 seconds → action runs, indicator stops pulsing, matched footer button briefly flashes a check.

If nothing is said in 5s, listener silently returns to wake-word state. If something is said but doesn't match any vocabulary, a "no match" bubble shows the heard text for ~1.5s.

### Wake word

User-selectable from openWakeWord's prebuilt list, default `computer`:
- `computer` (default)
- `hey jarvis`
- `alexa`
- `hey mycroft`
- `hey rhasspy`

A real "Orchestra" wake word requires custom training and is out of scope for v1.

### Vocabulary

Per-workspace footer custom actions are the targetable commands. Each action gets:
- Its name (existing field, used as the default voice phrase, normalized lowercase).
- An optional `voiceAliases: string[]` array (new field) for additional phrases — e.g. an action named "Deploy to prod" might add `["ship", "ship it"]`.

Vocabulary is pushed to the listener on app start, workspace switch, active-session switch, and any custom-action edit.

### Visual feedback (footer indicator)

Lives inside `NavBar.tsx` next to the existing action icons. Visual states:

| State | Visual |
|---|---|
| Disabled | Nothing rendered. |
| Idle (enabled, listening for wake) | Small mic dot at 30% opacity. |
| Awake (heard wake word, listening for command) | Mic pulses in workspace accent color. Bubble appears just above the footer (placeholder dot animation while transcribing — single-shot, no live partials in v1). |
| Match | Matched footer button flashes ✓ via existing `confirmedActions` mechanism. Bubble fades. |
| No match | Bubble shows heard text + "no match" hint for ~1.5s, then fades. No action runs. |
| Timeout | Indicator stops pulsing silently and returns to idle. No bubble. |

## Architecture

```
┌────────────────────────────── Renderer (React) ──────────────────────────────┐
│   NavBar  ──►  VoiceIndicator (footer pulse + transcription bubble)           │
│       ▲                                                                        │
│       │ IPC events:  voice:wake, voice:partial, voice:final, voice:matched    │
│       │              voice:idle, voice:error                                  │
└───────┼────────────────────────────────────────────────────────────────────────┘
        │
┌───────▼─────────────── Electron Main (TypeScript) ───────────────────────────┐
│   VoiceManager                                                                │
│     ├─ spawns Python sidecar on enable                                        │
│     ├─ writes vocabulary (action names + aliases) on workspace/active change  │
│     ├─ receives JSON events on stdout, forwards to renderer                   │
│     └─ dispatches matched intent → existing runAction(workspaceId, action)    │
└───────┼────────────────────────────────────────────────────────────────────────┘
        │ stdin (JSON commands) / stdout (JSON events)
┌───────▼─────────────── Python sidecar (`voice-sidecar/`) ────────────────────┐
│   sounddevice ──► VAD ──► openWakeWord ("computer")                           │
│                              │                                                │
│                              ▼ (wake fired)                                   │
│   sounddevice ──► VAD ──► parakeet-mlx (transcribe ~3s window)                │
│                              │                                                │
│                              ▼                                                │
│   intent matcher (fuzzy match against vocabulary) → emit JSON event           │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Three units, three responsibilities

1. **Python sidecar** — owns the mic, both models, intent matching. Stateless beyond "current vocabulary." Unit-testable by piping recorded WAVs.
2. **`VoiceManager` (main process)** — process lifecycle, vocabulary sync, intent → existing `runAction` dispatch. No audio handling.
3. **`VoiceIndicator` (renderer)** — pure UI subscribing to IPC events. No knowledge of audio or models.

### Key isolation property

The renderer never touches audio. `getUserMedia` is unused. The Python sidecar owns the mic directly via `sounddevice` so models get float32 frames at their native sample rate without Web Audio re-encoding and without macOS prompting twice for mic permission.

## Components

### Python sidecar — `apps/desktop/voice-sidecar/`

Three files:

- **`main.py`** — entrypoint. Reads JSON commands from stdin (`{"type":"set_vocab","words":[...]}`, `{"type":"shutdown"}`), writes JSON events to stdout. Owns the audio loop.
- **`pipeline.py`** — audio pipeline state machine:
  - `LISTENING_FOR_WAKE` — feed 16kHz mono frames to openWakeWord. On detection above threshold (default 0.6), emit `{"type":"wake"}` and transition.
  - `LISTENING_FOR_COMMAND` — buffer audio for up to 3s or until 700ms of silence (VAD). Run Parakeet on the buffer, emit `{"type":"final","text":"..."}`, run intent matching, emit `{"type":"matched","action_id":"..."}` or `{"type":"no_match","text":"..."}`. Return to `LISTENING_FOR_WAKE`. Hard timeout 5s after wake — if nothing heard, emit `{"type":"timeout"}` and return.
- **`intent.py`** — fuzzy matching. Takes transcript and current vocabulary (action_id → list of phrases). Normalized Levenshtein with confidence threshold (default 0.75). Returns best match or none.

Dependencies: `parakeet-mlx`, `openwakeword`, `sounddevice`, `numpy`. Python 3.11+. A `pyproject.toml` defines the env; a `setup.sh` creates a venv at `~/.orchestra/voice-venv/` on first enable.

### `VoiceManager` — `apps/desktop/src/main/voice/voice-manager.ts`

```ts
class VoiceManager {
  enable(): Promise<void>
  disable(): void
  isEnabled(): boolean
  setVocabulary(vocab: Vocab): void
  // emits: 'wake' | 'partial' | 'final' | 'matched' | 'no-match' | 'timeout' | 'error'
}
```

Registers IPC handlers (`voice:enable`, `voice:disable`) and a renderer-side listener (`onVoiceEvent`) via the existing `preload/index.ts` pattern. On a `matched` event, calls `runAction(workspaceId, action)` — the same store action the footer button click invokes — so background actions, claude/codex routing, and run-history work without per-feature plumbing.

Vocabulary rebuilt and pushed on: app start, workspace switch, active-session switch, any edit to `customActions` or their voice aliases.

### `VoiceIndicator` — `apps/desktop/src/renderer/src/components/VoiceIndicator.tsx`

Sits inside `NavBar.tsx`. Subscribes to IPC voice events from `window.electronAPI.onVoiceEvent`. Renders the four visual states described under "Visual feedback." Uses the existing `confirmedActions` flash mechanism for the match indicator — no new animation system.

### Storage (`electron-store`)

New settings keys:

- `voice.enabled: boolean` (default `false` — opt-in)
- `voice.wakeWord: 'computer' | 'hey jarvis' | 'alexa' | 'hey mycroft' | 'hey rhasspy'` (default `'computer'`)
- `voice.wakeWordThreshold: number` (default `0.6`, advanced setting)
- `voice.intentConfidenceThreshold: number` (default `0.75`, advanced setting)

Per-action aliases live on the existing `customAction` object as `voiceAliases?: string[]` — additive, no migration needed.

### Settings UI

A new Voice page in `SettingsDialog.tsx`:
- Enable toggle (triggers macOS mic permission prompt on first enable).
- Wake-word dropdown.
- Per-action alias editor (reuses existing custom-action edit UI).
- Advanced: thresholds, "Re-download model" button, "View sidecar logs" button.
- Status indicator: "Listening" / "Disabled" / "Error: {reason}".

## Data Flow (one full interaction)

```
User says: "computer ... ship"

t=0ms     mic captures audio frame (16kHz mono float32)
            └─► sidecar pipeline (LISTENING_FOR_WAKE)
                  └─► openWakeWord scores frame ≈ 0.02 (silence)

t=400ms   user starts saying "computer"
            └─► openWakeWord rolling score climbs

t=900ms   "computer" complete, oWW score crosses 0.6 threshold
            └─► sidecar emits → stdout: {"type":"wake","ts":...}
                  └─► VoiceManager → IPC → VoiceIndicator
                        └─► footer mic starts pulsing in wsColor
                  └─► sidecar transitions to LISTENING_FOR_COMMAND
                        └─► starts buffering audio, resets 5s timeout

t=1200ms  user starts saying "ship"
            └─► VAD active, audio appended to buffer

t=1700ms  user stops speaking (≈700ms silence detected by VAD)
            └─► sidecar runs parakeet-mlx on buffered ~500ms of audio
                  ► transcript: "ship"

t=1850ms  intent matcher runs against current vocab
            ─ vocab: [{action_id:"abc-1", phrases:["ship"]}, ...]
            └─► sidecar emits: {"type":"matched","action_id":"abc-1","text":"ship","confidence":1.0}

t=1860ms  VoiceManager receives "matched"
            └─► looks up customAction by id in active workspace
            └─► calls existing runAction(workspaceId, action)
                  ► (existing path: background command OR write to terminal OR launch claude/codex)
            └─► forwards to renderer
                  └─► VoiceIndicator: ship button flashes ✓
                  └─► VoiceIndicator: bubble fades
            └─► sidecar returns to LISTENING_FOR_WAKE
```

### Flow properties

- **Vocabulary is pushed, not pulled.** `VoiceManager.setVocabulary()` writes a `set_vocab` JSON line to sidecar stdin on every relevant change. Sidecar holds vocab in memory only.
- **Action execution reuses the existing path.** Voice doesn't get its own runner; it dispatches into `runAction(workspaceId, action)`.
- **The renderer is a passive observer.** Renders state from events. Falls back to "disabled" visual after a 2s heartbeat timeout if IPC goes silent.
- **Wake word never invokes Parakeet.** openWakeWord runs on every frame; Parakeet only runs on the post-wake buffer. Idle CPU stays low.
- **No-match path:** intent matcher below threshold → `no_match` event, renderer shows bubble, no action runs.
- **No chaining.** Each command requires a fresh wake-word.

## Error Handling

| Failure | Detection | Behavior |
|---|---|---|
| Sidecar fails to spawn | `child_process.spawn` errors or process exits within 2s | Disable feature, toast: "Voice setup failed — see Settings → Voice." Settings shows stderr. No auto-retry. |
| Sidecar crashes mid-run | `exit` event after successful start | Auto-restart up to 3 times within 60s with exponential backoff (1s, 4s, 16s). After 3 failures, disable + toast. Log stderr to rolling buffer. |
| Mic permission denied | sidecar emits `{"type":"error","code":"mic_denied"}` | Disable feature, toast pointing to System Settings → Privacy & Security. No auto-prompt again. |
| Mic device disappears | sidecar emits `{"type":"error","code":"mic_lost"}` | Pause listening, retry every 2s for 30s, then disable. Indicator goes red. |
| Parakeet model not downloaded | first transcription errors | Sidecar attempts one-time download on startup; on failure emit `{"type":"error","code":"model_missing"}` and disable. Settings exposes "Download model" button with progress. |
| Wake fires, nothing said (5s) | Pipeline timeout | Emit `{"type":"timeout"}`. Indicator stops pulsing, no toast. |
| Intent below threshold | Confidence < 0.75 | Emit `{"type":"no_match","text":"..."}`. Bubble shows heard text 1.5s. |
| Action name collision in workspace | At vocab build | First match wins by creation order, log warning. Settings shows badge next to ambiguous actions. |
| IPC silence (sidecar wedged) | Sidecar emits `{"type":"heartbeat"}` every 2s; main misses 3 | Kill + restart. Indicator amber during gap. |
| Workspace has zero matchable actions | At vocab push | Sidecar accepts empty vocab; wake fires but every command emits `no_match`. Bubble: "No voice actions in this workspace." |

### Operational constraints

- **First-run download.** Parakeet downloads ~600MB on first use. Settings shows progress. Feature stays disabled until model is on disk.
- **App lifecycle.** Voice runs while Orchestra is running (foreground or minimized). Quitting the app stops voice. No menu-bar daemon in v1.

## Testing Strategy

### Python sidecar — pytest

Audio-driving tests use a `sounddevice` mock that feeds frames from a WAV file at the natural sample rate, so the pipeline runs without a real mic. Recorded fixtures committed under `apps/desktop/voice-sidecar/tests/fixtures/`.

| Test | Fixture | What it proves |
|---|---|---|
| `test_wake_then_command` | `wake_then_ship.wav` | Pipeline emits `wake` → `final("ship")` → `matched(...)` in order |
| `test_wake_then_silence` | `wake_only.wav` | `wake` then `timeout` after 5s, no `matched` |
| `test_no_wake_in_chatter` | `meeting_chatter_60s.wav` | No `wake` event during clip — false-trigger guard |
| `test_unknown_command` | `wake_then_xyz.wav` | `wake` → `final("xyz...")` → `no_match`, never `matched` |
| `test_vocab_swap` | drives stdin | After mid-run `set_vocab`, "ship" stops matching, "deploy" starts matching |
| `test_intent_fuzzy` | unit, no audio | "shp", "ship it", "ship the thing" → match `ship`; "shipping container" does not |
| `test_intent_threshold` | unit, no audio | Below 0.75 returns `no_match` |

### `VoiceManager` — vitest with FakeSidecar

Unit tests don't spawn real Python. A `FakeSidecar` implements the same JSON-over-stdio contract; tests drive it via `fake.emit({type:"matched",...})`.

| Test | What it proves |
|---|---|
| Enable spawns once, disable kills | Process lifecycle — no zombies, no double-spawns |
| Vocab pushed on workspace switch | Store subscription fires `set_vocab` with correct word list |
| Vocab pushed on action edit | Adding/renaming/aliasing triggers a vocab push |
| Matched event runs the right action | `matched(action_id="abc")` calls `runAction(workspaceId, action)` exactly once |
| Matched event for stale action_id is dropped | If user deleted action between push and match, no crash, no run, log warning |
| Auto-restart on crash, give up after 3 fails | Lifecycle policy from Error Handling |
| Heartbeat timeout triggers restart | Wedge detection works |

### Renderer — vitest + RTL

| Test | What it proves |
|---|---|
| `VoiceIndicator` renders nothing when disabled | Disabled state |
| `VoiceIndicator` pulses on wake event | State transitions on IPC events |
| `VoiceIndicator` shows bubble on final event | Bubble appears with correct text |
| `VoiceIndicator` hides bubble after timeout/match | Bubble lifecycle |
| Settings → Voice toggles enable/disable via IPC | Settings UI wires to `VoiceManager` correctly |

### Out of scope for automated tests

- **Real mic capture in CI** — no GitHub Actions runner has a mic. We add `bun run voice:smoke` that runs the whole stack with a recorded WAV piped to stdin instead of the mic. Manual smoke test, covered by humans pre-release.
- **Real Parakeet model accuracy** — we trust upstream. Unit tests use mocked transcription output; the recorded-WAV smoke covers the real-model path manually.
- **openWakeWord false-trigger rate** beyond the single 60s chatter clip. Threshold tuning is empirical. We expose `voice.wakeWordThreshold` (default 0.6) for users to adjust.

## File Layout

New files:
```
apps/desktop/
  voice-sidecar/
    pyproject.toml
    setup.sh
    main.py
    pipeline.py
    intent.py
    tests/
      fixtures/   # WAVs
      test_pipeline.py
      test_intent.py
  src/main/voice/
    voice-manager.ts
    voice-manager.test.ts
    fake-sidecar.ts            # test helper
  src/renderer/src/components/
    VoiceIndicator.tsx
    VoiceIndicator.test.tsx
```

Modified files:
```
apps/desktop/
  src/preload/index.ts                       # add voice IPC bridge
  src/renderer/src/env.d.ts                  # types for voice IPC
  src/renderer/src/components/NavBar.tsx     # mount <VoiceIndicator />
  src/renderer/src/components/SettingsDialog.tsx  # add Voice page
  src/renderer/src/store/app-store.ts        # voice settings, vocab subscription
  src/shared/types.ts                        # add voiceAliases, voice settings types
```

No migrations required — `voiceAliases` and the new settings keys are additive optionals.

## Open Questions / Future Work

- Custom "Orchestra" wake word (separate spec — requires openWakeWord training pipeline, ~2-4hr GPU).
- Streaming partial transcripts (lower-latency feel; adds CPU and complexity).
- Chained commands ("stay awake" after match for ~5s).
- Cross-platform support (Windows/Linux).
- Voice control of `AgentFooterControls` (Approvals, model picker).
- Global verbs ("Maestro", "Settings", "Skills").
- Bundled standalone sidecar binary so users don't need to manage Python.
