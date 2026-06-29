# Remote Voice Dictation — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorm); pending implementation plan
**Owner:** Thiago

## Goal

Let me talk to an Orchestra agent by voice from anywhere — phone, on the street —
the same way I dictate locally with "Jack App" (press-and-hold to talk). Hold a
button in the Orchestra web mirror, speak, and have my words land in the focused
agent's input.

## Context

Orchestra already has the pieces this rides on:

- **Web mirror keyboard** (`apps/web/src/components/AgentKeyBar.tsx`) sends keys to
  the desktop via `convex.mutation(api.remote.sendCommand, { kind, payload })`,
  which the desktop writes straight into the agent's PTY. **Injecting transcribed
  text into the agent is therefore already a solved problem** — it is the same
  path as typing.
- **Convex** (`apps/backend/convex`) is the realtime mirror/signaling backbone.
  It is *not* a binary-audio relay. Backend is Convex-only — no standalone server.
- **`voice-sidecar`** (`apps/desktop/voice-sidecar`) is an existing Python process
  (16 kHz mono int16 PCM pipeline, stdin/stdout JSON IPC, injectable frame sources
  for tests). It does wake-word + intent matching off the **local** mic. We reuse
  its *architecture pattern*, not its wake-word logic.

"Jack App" is a separate, self-owned macOS dictation app (press-and-hold Right
Command → local Whisper → types into the focused field). It is the inspiration,
not a dependency.

## Decisions (and why)

1. **Reuse the existing text channel, not Jack's mic-and-keystroke shell.**
   The virtual-audio-driver + Right-Command-simulation + system-mic-swap approach
   exists only because Jack reads the system mic and types into a focused field.
   Remotely we already have a text channel into the agent, so we only need *text*.
   - ❌ No virtual audio driver / system-mic swap
   - ❌ No Right-Command (CGEvent) simulation
   - ❌ No WebRTC / TURN / relay server

2. **Transport: chunked audio over Convex** (not live WebRTC).
   Chosen for infra simplicity and cellular robustness, not engine limits. A live
   WebRTC pipe would add TURN servers, a relay box, and WebRTC glue — all new
   always-on infra for a solo-maintained, Convex-only backend — to shave latency
   we do not need. Independently-retried chunks are *more* robust on cellular than
   a live stream that dies on one dropped packet. Because Parakeet streams
   (Decision 3), feeding it small ~300–500 ms chunks keeps the decoder near-
   continuous, so the liveness gap vs. WebRTC is small. WebRTC stays a clean v2
   upgrade if sub-second latency is ever wanted.

   *(Note: the original brainstorm assumed Jack's Whisper — a ~1 s sliding-window
   model — which made chunked transport an obvious wash. Switching the sidecar to
   streaming Parakeet narrows that gap but does not change the decision: the infra
   and robustness arguments stand on their own.)*

3. **Engine: Parakeet v2 (English) as a new desktop dictation sidecar.**
   English-only is enough. Parakeet v2 is a true streaming FastConformer-TDT
   transducer → genuine word-by-word partials (smoother than Whisper's ~1 s
   sliding window), and it is **fully decoupled from Jack** (no shared model path
   or params). Runs on Apple Silicon via an MLX/CoreML Parakeet runtime
   (e.g. `parakeet-mlx`); NeMo proper is CUDA-painful and avoided. Because it
   streams, we use small ~300–500 ms chunks for snappy liveness.

4. **On release: review, then I hit Enter** (no auto-send).
   The final transcript lands in the agent input; I review and press the Enter
   key the bar already has. Avoids a misheard street sentence going straight to
   the agent.

## Architecture & data flow

```
PHONE (web, on the street)                    MAC (Orchestra desktop, at home)
─────────────────────────                     ────────────────────────────────
hold "🎤 Talk" button
  → getUserMedia (mic)
  → AudioWorklet → 16 kHz mono PCM16
  → slice ~300–500 ms chunks
  → appendChunk(seq, pcm) ──────Convex───────▶ dictation orchestrator
                                                  → reassemble chunks by seq
                                                  → feed Parakeet dictation sidecar
  ghost-text overlay  ◀──Convex(dictationState)─  ← emit streaming interim text
  (live preview as you talk)

release button
  → endDictation ───────────────Convex───────▶ sidecar finalizes utterance
                                                  → inject FINAL text into agent PTY
  overlay clears; text now in     ◀─────────────  (via existing remote.sendCommand path)
  the agent input — review, Enter
```

Liveness comes from interim text mirrored back to the phone as ghost text. Only
the **final** pass is written to the PTY, so the terminal never has to un-type a
wrong interim guess.

## Components

Four small, independently testable units.

### 1. Web — `useDictation` hook + "🎤 Talk" button
- **File(s):** new hook in `apps/web/src/hooks/`; button added to `AgentKeyBar.tsx`.
- **Does:** owns mic lifecycle and press/release. On press → `getUserMedia` +
  **AudioWorklet** emitting 16 kHz mono PCM16 (matches the sidecar audio contract;
  no codec/container headaches). Slices ~300–500 ms chunks, uploads them in order,
  renders interim transcript as ghost text.
- **Interface:** `{ isDictating, interimText, start(), stop() }`. Button uses
  `onPointerDown`/`onPointerUp` for press-and-hold and keeps the terminal focused
  (`onMouseDown` preventDefault, like the other keys).
- **Depends on:** existing Convex client + session token.

### 2. Convex — dictation API
- **File(s):** `apps/backend/convex/remoteDictation.ts` (or extend `remote.ts`).
- **Does:** transport + signaling + interim mirror.
  - `startDictation({ token, sessionId }) → dictationId`
  - `appendChunk({ dictationId, seq, pcm })` — ~300–500 ms PCM16 ≈ 10–16 KB,
    inline base64 (no file-storage round trip). Opus (~8× smaller) is a later
    tunable if cellular bandwidth ever bites.
  - `endDictation({ dictationId })`
  - reactive `dictationState` doc the desktop subscribes to, with an `interimText`
    field the phone subscribes to for the overlay.
- **Depends on:** existing `token` auth + remote session model.

### 3. Desktop — dictation orchestrator (main process)
- **Does:** the glue. Subscribes to `dictationState`/chunks, reassembles chunks by
  `seq` (orders + dedups), feeds the sidecar, writes interim text back to Convex
  (→ phone overlay), and on `final` injects text into the agent's PTY **through the
  exact path `remote.sendCommand` already uses** so dictated words arrive identically
  to typed ones.
- **Depends on:** desktop Convex client (exists), sidecar process management (mirror
  `voice-sidecar` spawn), PTY write path (exists).

### 4. Desktop — Parakeet dictation sidecar (new)
- **Does:** audio → text, streaming. stdin = JSON control + PCM frames; stdout =
  `{type:"interim",text}` / `{type:"final",text}`. Loads Parakeet v2 (English) via
  an Apple-Silicon MLX/CoreML runtime. Streams partials during the hold; emits a
  clean final on `end`.
- **Architecture:** mirror `voice-sidecar`'s injectable-source design
  (`run_with_sources(...)`) so unit tests drive it without real audio hardware.
- **Depends on:** a bundled Parakeet v2 model + MLX/CoreML runtime.

The only Jack-adjacent coupling is *conceptual* (same press-and-hold UX). No
dependency on the Jack App process running.

## Error handling & graceful degradation

- **Mic permission denied** → button shows a clear reason + re-prompt; no silent fail.
- **Desktop offline / session not mirrored / sidecar down** → button renders disabled
  with a reason, driven by `dictationState` + desktop presence.
- **Chunk upload failure** → retry with backoff; orchestrator orders/dedups by `seq`;
  the streaming decoder tolerates a missing chunk and still finalizes from what
  arrived on `end`.
- **Max hold cap (~60 s)** → auto-stop + finalize; bounds resource use.
- **One dictation per session** → a new press supersedes any prior via `dictationId`;
  stale state cleaned up on release/disconnect.
- **Terminal safety** → interim text is *only* mirrored to the phone overlay; **only
  the final pass is ever written to the PTY**.
- **Privacy** → audio chunks are transient: consumed by the sidecar and dropped,
  never persisted in Convex.

## Testing

- **Pure web helpers** (chunk slicing/sequencing, base64 framing) → unit tests,
  mirroring the pure-helper style in `apps/web/src/lib/keyboard.ts`.
- **Convex functions** (start/append/end, ordering, auth) → tests alongside the
  existing `remoteAuth.test.ts` precedent.
- **Sidecar** → feed recorded WAV fixtures through an injectable frame source (the
  `run_with_sources` pattern `voice-sidecar` already uses) and assert transcripts.
- **Orchestrator** → unit test chunk reassembly + interim/final routing with a fake
  sidecar and fake Convex.
- **Manual E2E** → phone on real cellular → live overlay → final injection into a
  real agent session → Enter.

## Open items for the implementation plan

- Confirm the exact Apple-Silicon Parakeet runtime (`parakeet-mlx` vs a CoreML
  export) and how the model is bundled/packaged with the desktop app.
- Final chunk size (300 vs 500 ms) — tune for partial smoothness vs mutation rate.
- Button placement within `AgentKeyBar` (new row vs slot) and disabled-state visuals.
- `dictationState` schema + lifecycle/GC details in Convex.
- Desktop-side reuse of the existing PTY write helper that `remote.sendCommand` calls.
```

## Non-goals (v1)

- Live WebRTC / sub-second latency (chunked-over-Convex is the v1 transport).
- Multi-language (English-only Parakeet v2 is sufficient).
- Auto-send (review-then-Enter only).
- Reusing/puppeting the Jack App process, virtual audio devices, or key simulation.
