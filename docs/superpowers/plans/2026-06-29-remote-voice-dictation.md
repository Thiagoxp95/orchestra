# Remote Voice Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold a "🎤 Talk" button in the Orchestra web mirror, speak from anywhere, and have your words land in the focused agent's input — transcribed on the Mac by the existing Parakeet model.

**Architecture:** The phone captures mic audio as 16 kHz mono PCM16, slices it into ~400 ms chunks, and uploads them over Convex. A desktop orchestrator subscribes to those chunks, feeds them to a long-lived Parakeet dictation sidecar (reusing the existing `voice-sidecar` venv), mirrors the interim transcript back to the phone as ghost text, and on release injects the final transcript into the agent's PTY through the **same `daemon.write` path** the existing `remote.sendCommand` `write` kind already uses. No virtual audio driver, no key simulation, no WebRTC.

**Tech Stack:** Convex (backend transport), Next.js + React + Web Audio API/AudioWorklet (web), Electron main process TypeScript (desktop orchestrator), Python + `parakeet-mlx` (sidecar). Tests: `vitest` (web + desktop main), `bun test` (Convex pure logic), `pytest` (sidecar).

## Global Constraints

Every task's requirements implicitly include these (copied from the design spec, `docs/superpowers/specs/2026-06-29-remote-voice-dictation-design.md`):

- **Audio format:** 16 kHz, mono, **int16 PCM** end-to-end (matches the existing sidecar's audio contract). Chunks are base64-encoded PCM16.
- **Transport:** chunked audio over **Convex only** — no WebRTC, no TURN, no new always-on relay service.
- **Engine:** reuse the **existing voice venv** (`~/.orchestra/voice-venv`) and its already-installed `parakeet-mlx` (`mlx-community/parakeet-tdt-0.6b-v2`). **No new Python dependency, no packaging change** — the new `dictation.py` lives in `apps/desktop/voice-sidecar/`, already shipped via `electron-builder.yml extraResources`.
- **Injection:** the **final** transcript is written to the agent PTY via `getDaemonClient().write(sessionId, text)`. The **interim** transcript is **only** mirrored to the phone overlay and **never** written to the PTY.
- **No auto-send:** ~~never append `\r`/Enter to the injected text.~~ **Superseded 2026-07-19 (as shipped):** auto-send requested — after the text write, a separate `'\r'` write fires ~300 ms later (fused `text\r` trips TUI paste detection and inserts a newline instead of submitting).
- **Privacy:** audio chunks are transient — the desktop deletes consumed chunks and the dictation row is pruned; audio is never persisted long-term.
- **Auth:** web-facing Convex functions authenticate with `token` (via `requireToken`); desktop-facing functions authenticate with `secret` (via `requireDevice`). Mirror `apps/backend/convex/remote.ts` exactly.
- **Code style:** Convex files use semicolons + double quotes; web and desktop-main TS use no semicolons + single quotes (match the file you are editing).

---

## File Structure

**Create:**
- `apps/backend/convex/dictation-logic.ts` — pure status/limit helpers (Convex, testable).
- `apps/backend/convex/dictation-logic.test.ts` — bun:test for the above.
- `apps/backend/convex/remoteDictation.ts` — dictation transport functions (web + device).
- `apps/web/src/lib/dictation.ts` — pure audio helpers (downsample, PCM16, base64, chunking).
- `apps/web/src/lib/dictation.test.ts` — vitest for the above.
- `apps/web/public/dictation-worklet.js` — AudioWorklet that posts Float32 frames.
- `apps/web/src/hooks/useDictation.ts` — mic capture + upload + interim subscription hook.
- `apps/desktop/voice-sidecar/dictation.py` — PCM-over-stdin Parakeet dictation sidecar.
- `apps/desktop/voice-sidecar/tests/test_dictation.py` — pytest for the sidecar core.
- `apps/desktop/src/main/dictation/dictation-sidecar.ts` — node spawn adapter for `dictation.py`.
- `apps/desktop/src/main/dictation/dictation-chunks.ts` — pure chunk-ordering helper.
- `apps/desktop/src/main/dictation/dictation-chunks.test.ts` — vitest for the above.
- `apps/desktop/src/main/dictation/dictation-orchestrator.ts` — the desktop glue.

**Modify:**
- `apps/backend/convex/schema.ts` — add `dictation` + `dictationChunks` tables.
- `apps/backend/convex/remote.ts` — extend `pruneRemote` to also prune stale dictation rows/chunks.
- `apps/web/src/components/AgentKeyBar.tsx` — add the press-and-hold "🎤 Talk" button.
- `apps/web/src/components/Terminal.tsx` — own `useDictation`, render the ghost overlay, wire the button.
- `apps/desktop/src/main/index.ts` — start the dictation orchestrator after `startRemoteBridge`.

---

## Task 1: Convex dictation transport

**Files:**
- Create: `apps/backend/convex/dictation-logic.ts`
- Test: `apps/backend/convex/dictation-logic.test.ts`
- Create: `apps/backend/convex/remoteDictation.ts`
- Modify: `apps/backend/convex/schema.ts` (add tables)
- Modify: `apps/backend/convex/remote.ts:158-181` (extend `pruneRemote`)

**Interfaces:**
- Consumes: `requireToken`, `requireDevice` patterns from `remote.ts` (re-implemented locally — they are not exported).
- Produces (Convex API surface used by Tasks 3, 4, 8):
  - `remoteDictation.startDictation({ token: string, dictationId: string, sessionId: string })`
  - `remoteDictation.appendDictationChunk({ token: string, dictationId: string, seq: number, pcm: string })`
  - `remoteDictation.endDictation({ token: string, dictationId: string })`
  - `remoteDictation.cancelDictation({ token: string, dictationId: string })`
  - `remoteDictation.getDictation({ token: string, dictationId: string }) → DictationRow | null`
  - `remoteDictation.pendingDictation({ secret: string }) → DictationRow[]`
  - `remoteDictation.getDictationChunks({ secret: string, dictationId: string, afterSeq: number }) → ChunkRow[]`
  - `remoteDictation.setDictationInterim({ secret: string, dictationId: string, interimText: string })`
  - `remoteDictation.finalizeDictation({ secret: string, dictationId: string, finalText: string })`
  - `remoteDictation.deleteDictationChunks({ secret: string, dictationId: string, throughSeq: number })`
  - Pure: `canAppendChunk(status): boolean`, `MAX_PCM_CHUNK_B64`, `isChunkWithinLimit(b64Length): boolean`, `DictationStatus`
  - `DictationRow` shape: `{ dictationId, sessionId, status, interimText, finalText?, createdAt, updatedAt }`

- [ ] **Step 1: Write the failing test for the pure logic**

Create `apps/backend/convex/dictation-logic.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { canAppendChunk, isChunkWithinLimit, MAX_PCM_CHUNK_B64 } from "./dictation-logic";

describe("canAppendChunk", () => {
  it("allows appending while recording", () => {
    expect(canAppendChunk("recording")).toBe(true);
  });
  it("rejects appending once ended/done/cancelled", () => {
    expect(canAppendChunk("ended")).toBe(false);
    expect(canAppendChunk("done")).toBe(false);
    expect(canAppendChunk("cancelled")).toBe(false);
  });
});

describe("isChunkWithinLimit", () => {
  it("accepts a normal ~400ms chunk", () => {
    // 400ms @ 16kHz mono int16 = 12800 bytes → base64 ≈ 17068 chars
    expect(isChunkWithinLimit(17068)).toBe(true);
  });
  it("rejects an oversized chunk", () => {
    expect(isChunkWithinLimit(MAX_PCM_CHUNK_B64 + 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/backend && bun test convex/dictation-logic.test.ts`
Expected: FAIL — `Cannot find module './dictation-logic'`.

- [ ] **Step 3: Implement the pure logic**

Create `apps/backend/convex/dictation-logic.ts`:

```ts
// Pure, dependency-free helpers for the dictation transport. Kept out of the
// Convex function files so they unit-test under bun:test exactly like
// remoteAuth.ts's checkCredentials.

export type DictationStatus = "recording" | "ended" | "done" | "cancelled";

// A chunk may only be appended while the phone is still holding the button.
export function canAppendChunk(status: DictationStatus): boolean {
  return status === "recording";
}

// ~1s of 16kHz mono PCM16 base64 ≈ 43.7k chars. Cap generously above the
// largest chunk the client emits (~400ms) so a malformed/oversized upload is
// rejected before it bloats a Convex document.
export const MAX_PCM_CHUNK_B64 = 96_000;

export function isChunkWithinLimit(b64Length: number): boolean {
  return b64Length > 0 && b64Length <= MAX_PCM_CHUNK_B64;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/backend && bun test convex/dictation-logic.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Add the schema tables**

In `apps/backend/convex/schema.ts`, add these two tables inside `defineSchema({ ... })` (place them right after the `ptyCommands` table, before `pushSubscriptions`):

```ts
  // ── Remote voice dictation ────────────────────────────────────────────

  // One row per dictation utterance. Web writes start/end/cancel; the desktop
  // orchestrator writes interimText (mirrored to the phone overlay) and
  // finalText (also injected into the PTY).
  dictation: defineTable({
    dictationId: v.string(),   // client-generated uuid
    sessionId: v.string(),     // target agent session
    status: v.union(
      v.literal("recording"),
      v.literal("ended"),
      v.literal("done"),
      v.literal("cancelled"),
    ),
    interimText: v.string(),
    finalText: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dictationId", ["dictationId"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  // Audio chunks for an in-flight dictation. Web appends base64 PCM16; the
  // desktop reads them in seq order, feeds the sidecar, then deletes them.
  dictationChunks: defineTable({
    dictationId: v.string(),
    seq: v.number(),
    pcm: v.string(),           // base64 PCM16 mono 16kHz
    createdAt: v.number(),
  })
    .index("by_dictation_seq", ["dictationId", "seq"])
    .index("by_created", ["createdAt"]),
```

- [ ] **Step 6: Implement the dictation functions**

Create `apps/backend/convex/remoteDictation.ts`:

```ts
import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { canAppendChunk, isChunkWithinLimit, type DictationStatus } from "./dictation-logic";

async function requireToken(ctx: QueryCtx | MutationCtx, token: string): Promise<void> {
  const row = await ctx.db
    .query("authSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!row) throw new Error("unauthorized");
}

function requireDevice(secret: string): void {
  if (!process.env.DEVICE_SECRET || secret !== process.env.DEVICE_SECRET) {
    throw new Error("unauthorized");
  }
}

async function byDictationId(ctx: QueryCtx | MutationCtx, dictationId: string) {
  return ctx.db
    .query("dictation")
    .withIndex("by_dictationId", (q) => q.eq("dictationId", dictationId))
    .unique();
}

// ── Web → device (token-authed) ───────────────────────────────────────────

export const startDictation = mutation({
  args: { token: v.string(), dictationId: v.string(), sessionId: v.string() },
  handler: async (ctx, { token, dictationId, sessionId }) => {
    await requireToken(ctx, token);
    const existing = await byDictationId(ctx, dictationId);
    if (existing) return; // idempotent on retry
    const now = Date.now();
    await ctx.db.insert("dictation", {
      dictationId,
      sessionId,
      status: "recording",
      interimText: "",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const appendDictationChunk = mutation({
  args: { token: v.string(), dictationId: v.string(), seq: v.number(), pcm: v.string() },
  handler: async (ctx, { token, dictationId, seq, pcm }) => {
    await requireToken(ctx, token);
    if (!isChunkWithinLimit(pcm.length)) throw new Error("chunk too large");
    const row = await byDictationId(ctx, dictationId);
    if (!row || !canAppendChunk(row.status as DictationStatus)) return; // dropped after end
    await ctx.db.insert("dictationChunks", { dictationId, seq, pcm, createdAt: Date.now() });
  },
});

export const endDictation = mutation({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (row && row.status === "recording") {
      await ctx.db.patch(row._id, { status: "ended", updatedAt: Date.now() });
    }
  },
});

export const cancelDictation = mutation({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (row && row.status !== "done") {
      await ctx.db.patch(row._id, { status: "cancelled", updatedAt: Date.now() });
    }
  },
});

export const getDictation = query({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    return await byDictationId(ctx, dictationId);
  },
});

// ── Device → web (secret-authed) ──────────────────────────────────────────

export const pendingDictation = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireDevice(secret);
    const recording = await ctx.db
      .query("dictation")
      .withIndex("by_status", (q) => q.eq("status", "recording"))
      .collect();
    const ended = await ctx.db
      .query("dictation")
      .withIndex("by_status", (q) => q.eq("status", "ended"))
      .collect();
    return [...recording, ...ended].sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const getDictationChunks = query({
  args: { secret: v.string(), dictationId: v.string(), afterSeq: v.number() },
  handler: async (ctx, { secret, dictationId, afterSeq }) => {
    requireDevice(secret);
    return await ctx.db
      .query("dictationChunks")
      .withIndex("by_dictation_seq", (q) => q.eq("dictationId", dictationId).gt("seq", afterSeq))
      .order("asc")
      .take(200);
  },
});

export const setDictationInterim = mutation({
  args: { secret: v.string(), dictationId: v.string(), interimText: v.string() },
  handler: async (ctx, { secret, dictationId, interimText }) => {
    requireDevice(secret);
    const row = await byDictationId(ctx, dictationId);
    if (row) await ctx.db.patch(row._id, { interimText, updatedAt: Date.now() });
  },
});

export const finalizeDictation = mutation({
  args: { secret: v.string(), dictationId: v.string(), finalText: v.string() },
  handler: async (ctx, { secret, dictationId, finalText }) => {
    requireDevice(secret);
    const row = await byDictationId(ctx, dictationId);
    if (row) await ctx.db.patch(row._id, { status: "done", finalText, updatedAt: Date.now() });
  },
});

export const deleteDictationChunks = mutation({
  args: { secret: v.string(), dictationId: v.string(), throughSeq: v.number() },
  handler: async (ctx, { secret, dictationId, throughSeq }) => {
    requireDevice(secret);
    const rows = await ctx.db
      .query("dictationChunks")
      .withIndex("by_dictation_seq", (q) => q.eq("dictationId", dictationId).lte("seq", throughSeq))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});
```

- [ ] **Step 7: Extend `pruneRemote` to clean up stale dictation data**

In `apps/backend/convex/remote.ts`, inside the `pruneRemote` handler (currently ends at line 180), add after the existing `oldCmds` deletion loop, before the handler closes:

```ts
    // Dictation rows + chunks are short-lived; reap anything older than 5 min in
    // case a desktop disconnected mid-utterance and never consumed/finalized it.
    const dictCutoff = now - 5 * 60_000;
    const oldDictChunks = await ctx.db
      .query("dictationChunks")
      .withIndex("by_created", (q) => q.lt("createdAt", dictCutoff))
      .take(3000);
    for (const c of oldDictChunks) await ctx.db.delete(c._id);
    const oldDict = await ctx.db
      .query("dictation")
      .withIndex("by_created", (q) => q.lt("createdAt", dictCutoff))
      .take(1000);
    for (const d of oldDict) await ctx.db.delete(d._id);
```

- [ ] **Step 8: Verify the backend typechecks and pure tests pass**

Run: `cd apps/backend && bun test convex/dictation-logic.test.ts && bun run typecheck`
Expected: tests PASS; `tsc --noEmit` reports no errors. (Convex codegen for the new functions happens on `convex dev`/deploy; the typecheck covers the static TS.)

- [ ] **Step 9: Commit**

```bash
git add apps/backend/convex/dictation-logic.ts apps/backend/convex/dictation-logic.test.ts apps/backend/convex/remoteDictation.ts apps/backend/convex/schema.ts apps/backend/convex/remote.ts
git commit -m "feat(backend): convex transport for remote voice dictation"
```

---

## Task 2: Web audio pure helpers + AudioWorklet

**Files:**
- Create: `apps/web/src/lib/dictation.ts`
- Test: `apps/web/src/lib/dictation.test.ts`
- Create: `apps/web/public/dictation-worklet.js`

**Interfaces:**
- Produces (used by Task 3):
  - `TARGET_SAMPLE_RATE = 16000`, `CHUNK_MS = 400`
  - `downsampleTo16k(input: Float32Array, inputRate: number): Float32Array`
  - `floatTo16BitPCM(input: Float32Array): Int16Array`
  - `int16ToBase64(pcm: Int16Array): string`
  - `samplesPerChunk(rate: number): number`
  - AudioWorklet processor registered as `"pcm-capture"`, posts `Float32Array` (mono) frames via `port.postMessage`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/dictation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  downsampleTo16k,
  floatTo16BitPCM,
  int16ToBase64,
  samplesPerChunk,
  TARGET_SAMPLE_RATE,
} from './dictation'

describe('floatTo16BitPCM', () => {
  it('maps the float range to int16 and clamps', () => {
    const out = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768])
  })
})

describe('downsampleTo16k', () => {
  it('returns input unchanged when already 16k', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo16k(input, TARGET_SAMPLE_RATE)).toBe(input)
  })
  it('reduces length by the rate ratio (48k → 16k = /3)', () => {
    const input = new Float32Array(48000).fill(0.5)
    const out = downsampleTo16k(input, 48000)
    expect(out.length).toBe(16000)
  })
})

describe('int16ToBase64', () => {
  it('round-trips through atob to the original little-endian bytes', () => {
    const pcm = new Int16Array([0, 256, -1])
    const b64 = int16ToBase64(pcm)
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    // 0x0000, 0x0100, 0xFFFF little-endian
    expect(Array.from(bytes)).toEqual([0, 0, 0, 1, 255, 255])
  })
})

describe('samplesPerChunk', () => {
  it('is 400ms worth of samples at 16k', () => {
    expect(samplesPerChunk(TARGET_SAMPLE_RATE)).toBe(6400)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/dictation.test.ts`
Expected: FAIL — cannot resolve `./dictation`.

- [ ] **Step 3: Implement the helpers**

Create `apps/web/src/lib/dictation.ts`:

```ts
// Pure audio helpers for remote dictation. The browser mic runs at the
// AudioContext's native rate (commonly 48k); we downsample to 16k mono PCM16
// to match the desktop sidecar's audio contract, then base64-encode for Convex.

export const TARGET_SAMPLE_RATE = 16000
export const CHUNK_MS = 400

/** Number of 16k samples in one upload chunk. */
export function samplesPerChunk(rate: number): number {
  return Math.round((rate * CHUNK_MS) / 1000)
}

/** Linear-interpolation downsample to 16k. Returns input untouched if already 16k. */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input
  if (inputRate < TARGET_SAMPLE_RATE) return input // never upsample; caller shouldn't hit this
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** Float [-1,1] → int16, clamped. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Int16 PCM → base64 of its little-endian bytes. */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  const CHUNK = 0x8000 // avoid String.fromCharCode arg-count overflow
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/dictation.test.ts`
Expected: PASS (5 assertions). Note: `int16ToBase64` assumes a little-endian platform (every browser/Node we target).

- [ ] **Step 5: Create the AudioWorklet processor**

Create `apps/web/public/dictation-worklet.js` (served from the site root as `/dictation-worklet.js`):

`AudioWorkletProcessor` and `registerProcessor` are globals inside the worklet scope — do not namespace them. The buffer behind `input[0]` is reused by the audio thread on the next quantum, so `.slice(0)` to copy before posting:

```js
// Posts mono Float32 frames from the mic to the main thread. Registered as
// "pcm-capture". The main thread accumulates, downsamples to 16k, and uploads.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0))
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
```

- [ ] **Step 6: Verify the worklet is syntactically valid**

Run: `cd apps/web && node --check public/dictation-worklet.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/dictation.ts apps/web/src/lib/dictation.test.ts apps/web/public/dictation-worklet.js
git commit -m "feat(web): pure audio helpers + AudioWorklet for dictation"
```

---

## Task 3: Web `useDictation` hook

**Files:**
- Create: `apps/web/src/hooks/useDictation.ts`

**Interfaces:**
- Consumes: `downsampleTo16k`, `floatTo16BitPCM`, `int16ToBase64`, `samplesPerChunk`, `TARGET_SAMPLE_RATE` (Task 2); `anyApi.remoteDictation.*` (Task 1); `useConvex`, `useQuery` from `convex/react`.
- Produces (used by Task 4):
  - `useDictation(token: string, sessionId: string): DictationControls`
  - `interface DictationControls { isDictating: boolean; interimText: string; error: string | null; start: () => void; stop: () => void }`

- [ ] **Step 1: Implement the hook**

Create `apps/web/src/hooks/useDictation.ts`:

```ts
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import {
  downsampleTo16k,
  floatTo16BitPCM,
  int16ToBase64,
  samplesPerChunk,
  TARGET_SAMPLE_RATE,
} from '../lib/dictation'

export interface DictationControls {
  isDictating: boolean
  interimText: string
  error: string | null
  start: () => void
  stop: () => void
}

// Hard cap so a stuck button on the street can't record forever.
const MAX_HOLD_MS = 60_000

export function useDictation(token: string, sessionId: string): DictationControls {
  const convex = useConvex()
  const [isDictating, setIsDictating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dictationId, setDictationId] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const accRef = useRef<Float32Array[]>([])
  const accLenRef = useRef(0)
  const seqRef = useRef(0)
  const idRef = useRef<string | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Subscribe to this dictation's row so we can mirror interim text (and clear
  // once the desktop finalizes — finalText is injected into the PTY there).
  const row = useQuery(
    anyApi.remoteDictation.getDictation,
    dictationId ? { token, dictationId } : 'skip',
  ) as { interimText?: string; status?: string } | null | undefined
  const interimText = row?.status === 'done' ? '' : (row?.interimText ?? '')

  const flushChunk = useCallback(
    (rate: number) => {
      const id = idRef.current
      if (!id) return
      const total = accLenRef.current
      const merged = new Float32Array(total)
      let off = 0
      for (const a of accRef.current) {
        merged.set(a, off)
        off += a.length
      }
      accRef.current = []
      accLenRef.current = 0
      const pcm = floatTo16BitPCM(downsampleTo16k(merged, rate))
      const b64 = int16ToBase64(pcm)
      void convex.mutation(anyApi.remoteDictation.appendDictationChunk, {
        token,
        dictationId: id,
        seq: seqRef.current++,
        pcm: b64,
      })
    },
    [convex, token],
  )

  const teardown = useCallback(() => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    maxTimerRef.current = null
    nodeRef.current?.disconnect()
    nodeRef.current = null
    void ctxRef.current?.close()
    ctxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    accRef.current = []
    accLenRef.current = 0
  }, [])

  const stop = useCallback(() => {
    if (!isDictating) return
    setIsDictating(false)
    const id = idRef.current
    const rate = ctxRef.current?.sampleRate ?? TARGET_SAMPLE_RATE
    if (accLenRef.current > 0) flushChunk(rate)
    teardown()
    if (id) void convex.mutation(anyApi.remoteDictation.endDictation, { token, dictationId: id })
  }, [convex, flushChunk, isDictating, teardown, token])

  const start = useCallback(() => {
    if (isDictating) return
    setError(null)
    const id = crypto.randomUUID()
    idRef.current = id
    seqRef.current = 0
    setDictationId(id)
    setIsDictating(true)
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        const ctx = new AudioContext()
        ctxRef.current = ctx
        await ctx.audioWorklet.addModule('/dictation-worklet.js')
        const source = ctx.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(ctx, 'pcm-capture')
        nodeRef.current = node
        const chunkSamples = samplesPerChunk(ctx.sampleRate)
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          accRef.current.push(ev.data)
          accLenRef.current += ev.data.length
          if (accLenRef.current >= chunkSamples) flushChunk(ctx.sampleRate)
        }
        source.connect(node)
        // Worklets only pull when connected to a destination; a zero-gain sink
        // keeps the graph running without echoing the mic to the speakers.
        const sink = ctx.createGain()
        sink.gain.value = 0
        node.connect(sink).connect(ctx.destination)
        await convex.mutation(anyApi.remoteDictation.startDictation, { token, dictationId: id, sessionId })
        maxTimerRef.current = setTimeout(stop, MAX_HOLD_MS)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'microphone unavailable')
        setIsDictating(false)
        teardown()
        if (idRef.current) {
          void convex.mutation(anyApi.remoteDictation.cancelDictation, { token, dictationId: idRef.current })
        }
      }
    })()
  }, [convex, flushChunk, isDictating, sessionId, stop, teardown, token])

  // Stop cleanly if the component unmounts mid-utterance.
  useEffect(() => () => { teardown() }, [teardown])

  return { isDictating, interimText, error, start, stop }
}
```

- [ ] **Step 2: Typecheck the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors. (`anyApi.remoteDictation.*` is untyped via `anyApi`, matching how `Terminal.tsx` calls `anyApi.remote.sendCommand` — no generated types required.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useDictation.ts
git commit -m "feat(web): useDictation hook — mic capture, chunked upload, interim subscription"
```

---

## Task 4: Web "🎤 Talk" button + interim overlay

**Files:**
- Modify: `apps/web/src/components/AgentKeyBar.tsx`
- Modify: `apps/web/src/components/Terminal.tsx`

**Interfaces:**
- Consumes: `useDictation` (Task 3).
- Produces: visible press-and-hold dictation in the web terminal — no downstream consumer.

- [ ] **Step 1: Add dictation props + button to `AgentKeyBar`**

In `apps/web/src/components/AgentKeyBar.tsx`, change the import line and the props interface, and add a dictation button. Replace the import on line 2:

```tsx
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Delete, Mic } from 'lucide-react'
```

Extend the props interface (currently lines 9-13):

```tsx
interface AgentKeyBarProps {
  mods: Modifiers
  onToggleMod: (name: ModName) => void
  onSpecial: (key: string) => void
  isDictating: boolean
  onDictateStart: () => void
  onDictateStop: () => void
}
```

Update the function signature and add the button as the first item of the second row. Replace the function body's opening + the second `<div className="flex gap-1.5">` row:

```tsx
export function AgentKeyBar({
  mods,
  onToggleMod,
  onSpecial,
  isDictating,
  onDictateStart,
  onDictateStop,
}: AgentKeyBarProps) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-sidebar p-1.5">
      <div className="flex gap-1.5">
        <KeyBtn onClick={() => onSpecial('esc')}>Esc</KeyBtn>
        <KeyBtn onClick={() => onSpecial('tab')}>Tab</KeyBtn>
        <KeyBtn active={mods.ctrl} onClick={() => onToggleMod('ctrl')}>
          Ctrl
        </KeyBtn>
        <KeyBtn aria-label="Up" onClick={() => onSpecial('up')}>
          <ArrowUp className="size-4" />
        </KeyBtn>
        <KeyBtn active={mods.shift} onClick={() => onToggleMod('shift')}>
          Shift
        </KeyBtn>
        <KeyBtn aria-label="Backspace" onClick={() => onSpecial('backspace')}>
          <Delete className="size-4" />
        </KeyBtn>
      </div>
      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={isDictating ? 'default' : 'outline'}
          aria-label="Hold to talk"
          aria-pressed={isDictating}
          // Keep the terminal focused so the device keyboard stays open.
          onMouseDown={(e) => e.preventDefault()}
          // Press-and-hold via pointer events: down = record, up/leave/cancel = stop.
          onPointerDown={(e) => {
            e.preventDefault()
            onDictateStart()
          }}
          onPointerUp={onDictateStop}
          onPointerLeave={() => {
            if (isDictating) onDictateStop()
          }}
          onPointerCancel={onDictateStop}
          className={cn('h-9 flex-1 min-w-0 px-0 text-xs font-medium', isDictating && 'animate-pulse')}
        >
          <Mic className="size-4" />
        </Button>
        <KeyBtn active={mods.alt} onClick={() => onToggleMod('alt')}>
          Alt
        </KeyBtn>
        <KeyBtn onClick={() => onSpecial('space')}>Space</KeyBtn>
        <KeyBtn aria-label="Left" onClick={() => onSpecial('left')}>
          <ArrowLeft className="size-4" />
        </KeyBtn>
        <KeyBtn aria-label="Down" onClick={() => onSpecial('down')}>
          <ArrowDown className="size-4" />
        </KeyBtn>
        <KeyBtn aria-label="Right" onClick={() => onSpecial('right')}>
          <ArrowRight className="size-4" />
        </KeyBtn>
        <KeyBtn onClick={() => onSpecial('enter')}>Enter</KeyBtn>
      </div>
    </div>
  )
}
```

(The `Button` import already exists at the top of the file.)

- [ ] **Step 2: Wire `useDictation` + overlay into `TerminalPane`**

In `apps/web/src/components/Terminal.tsx`:

(a) Add the hook import after the other imports (near line 14):

```tsx
import { useDictation } from '../hooks/useDictation'
```

(b) Inside `TerminalPane`, after the `modsRef` block (around line 60), instantiate the hook:

```tsx
  const { isDictating, interimText, error: dictationError, start: onDictateStart, stop: onDictateStop } =
    useDictation(token, sessionId)
```

(c) Render a ghost-text overlay inside the viewport and pass the new props to `AgentKeyBar`. Replace the `return (...)` JSX (lines 317-329) with:

```tsx
  return (
    <div className="flex h-full flex-col">
      {/* Viewport clips the scaled terminal; the scaler shrinks the desktop-width
          xterm to fit without resizing the shared PTY. */}
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <div ref={scaleRef} className="absolute left-0 top-0 origin-top-left">
          <div ref={hostRef} />
        </div>
        {(isDictating || interimText || dictationError) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-black/70 px-3 py-2 text-sm text-white/90 backdrop-blur">
            {dictationError ? (
              <span className="text-red-300">🎤 {dictationError}</span>
            ) : (
              <span>
                <span className="mr-1 animate-pulse">🎤</span>
                {interimText || 'Listening…'}
              </span>
            )}
          </div>
        )}
      </div>
      <AgentKeyBar
        mods={mods}
        onToggleMod={onToggleMod}
        onSpecial={onSpecial}
        isDictating={isDictating}
        onDictateStart={onDictateStart}
        onDictateStop={onDictateStop}
      />
      <ActionBar token={token} onActionFired={onActionFired} />
    </div>
  )
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build to confirm the worklet + bundle are valid**

Run: `cd apps/web && npx next build`
Expected: build succeeds. (Manual end-to-end verification happens in Task 8 once the desktop side exists.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AgentKeyBar.tsx apps/web/src/components/Terminal.tsx
git commit -m "feat(web): hold-to-talk button + live interim overlay"
```

---

## Task 5: Python Parakeet dictation sidecar

**Files:**
- Create: `apps/desktop/voice-sidecar/dictation.py`
- Test: `apps/desktop/voice-sidecar/tests/test_dictation.py`

**Interfaces:**
- Consumes: `ParakeetTranscriber`, `emit_json`, `StdinCommandReader` from `main.py`.
- Produces (used by Task 6 over stdin/stdout JSON lines):
  - **stdin commands:** `{"type":"audio","pcm":"<base64 int16>"}`, `{"type":"end"}`, `{"type":"reset"}`, `{"type":"shutdown"}`
  - **stdout events:** `{"type":"ready"}`, `{"type":"interim","text":"..."}`, `{"type":"final","text":"..."}`, `{"type":"error","code":"...","message":"..."}`
  - Testable core: `run_dictation_with_sources(*, commands, emit, transcriber, min_interim_interval_s=0.5, clock=time.monotonic, should_stop=None, idle_sleep=...)`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/voice-sidecar/tests/test_dictation.py`:

```python
import base64

from dictation import run_dictation_with_sources


class FakeTranscriber:
    """Returns text proportional to how many bytes it has been given, so the
    test can assert interim/final fire on the accumulated buffer."""

    def transcribe(self, audio_bytes: bytes) -> str:
        return f"len={len(audio_bytes)}"


def _pcm(nbytes: int) -> str:
    return base64.b64encode(b"\x01\x00" * (nbytes // 2)).decode("ascii")


def test_emits_final_on_end_over_full_buffer():
    cmds = [
        {"type": "audio", "pcm": _pcm(100)},
        {"type": "audio", "pcm": _pcm(100)},
        {"type": "end"},
        {"type": "shutdown"},
    ]
    out = []
    queue = list(cmds)
    run_dictation_with_sources(
        commands=lambda: queue.pop(0) if queue else None,
        emit=out.append,
        transcriber=FakeTranscriber(),
        min_interim_interval_s=999,  # suppress interim; isolate the final
        clock=lambda: 0.0,
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    finals = [e for e in out if e["type"] == "final"]
    assert finals == [{"type": "final", "text": "len=200"}]


def test_emits_interim_on_cadence_then_clears_on_end():
    queue = [
        {"type": "audio", "pcm": _pcm(40)},
        {"type": "end"},
        {"type": "shutdown"},
    ]
    out = []
    ticks = iter([0.0, 0.0, 1.0, 1.0, 2.0, 2.0, 2.0])
    run_dictation_with_sources(
        commands=lambda: queue.pop(0) if queue else None,
        emit=out.append,
        transcriber=FakeTranscriber(),
        min_interim_interval_s=0.5,
        clock=lambda: next(ticks, 9.0),
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    kinds = [e["type"] for e in out]
    assert "interim" in kinds
    assert kinds[-1] == "final"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop/voice-sidecar && python -m pytest tests/test_dictation.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'dictation'`.

- [ ] **Step 3: Implement the sidecar**

Create `apps/desktop/voice-sidecar/dictation.py`:

```python
"""Orchestra remote-dictation sidecar.

Reads JSON commands from stdin (one per line):
    {"type": "audio", "pcm": "<base64 int16 mono 16k>"}
    {"type": "end"}        # finalize current utterance
    {"type": "reset"}      # drop the current buffer (new utterance)
    {"type": "shutdown"}

Writes JSON events to stdout (one per line):
    {"type": "ready"}
    {"type": "interim", "text": "..."}
    {"type": "final", "text": "..."}
    {"type": "error", "code": "...", "message": "..."}

Reuses ParakeetTranscriber from main.py — the same model the wake-word sidecar
loads — so there is no new dependency and no packaging change. Transcription
re-runs over the whole accumulated utterance each interim; utterances are short
(<=60s) so the O(n^2) cost is acceptable for v1.
"""

from __future__ import annotations

import base64
import signal
import sys
import time
from typing import Any, Callable, Optional

from main import ParakeetTranscriber, StdinCommandReader, emit_json


def run_dictation_with_sources(
    *,
    commands: Callable[[], Optional[dict]],
    emit: Callable[[dict], None],
    transcriber: Any,
    min_interim_interval_s: float = 0.5,
    clock: Callable[[], float] = time.monotonic,
    should_stop: Optional[Callable[[], bool]] = None,
    idle_sleep: Callable[[], None] = lambda: time.sleep(0.01),
) -> None:
    """Drive the dictation loop from injected sources (testable)."""
    buf = bytearray()
    dirty = False
    last_interim = clock()

    while True:
        if should_stop and should_stop():
            break
        cmd = commands()
        if cmd is None:
            now = clock()
            if dirty and buf and (now - last_interim) >= min_interim_interval_s:
                emit({"type": "interim", "text": transcriber.transcribe(bytes(buf))})
                last_interim = now
                dirty = False
            idle_sleep()
            continue

        ctype = cmd.get("type")
        if ctype == "audio":
            try:
                buf += base64.b64decode(cmd.get("pcm", ""))
                dirty = True
            except Exception:
                pass  # drop a malformed chunk rather than crash the utterance
        elif ctype == "end":
            text = transcriber.transcribe(bytes(buf)) if buf else ""
            emit({"type": "final", "text": text})
            buf = bytearray()
            dirty = False
            last_interim = clock()
        elif ctype == "reset":
            buf = bytearray()
            dirty = False
        elif ctype == "shutdown":
            break


def run() -> int:  # pragma: no cover - exercised manually / in smoke
    out = sys.stdout

    def emit(payload: dict) -> None:
        emit_json(out, payload)

    try:
        transcriber = ParakeetTranscriber()
    except Exception as exc:
        emit({"type": "error", "code": "model_missing", "message": f"parakeet-mlx init failed: {exc}"})
        return 2

    reader = StdinCommandReader.start()
    stop_flag = {"v": False}

    def _on_signal(_signum: int, _frame: object) -> None:
        stop_flag["v"] = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    emit({"type": "ready"})
    run_dictation_with_sources(
        commands=reader.try_get,
        emit=emit,
        transcriber=transcriber,
        should_stop=lambda: stop_flag["v"],
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run())
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop/voice-sidecar && python -m pytest tests/test_dictation.py -q`
Expected: PASS (2 tests). This uses a `FakeTranscriber`, so it runs without the MLX model or any audio hardware.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/voice-sidecar/dictation.py apps/desktop/voice-sidecar/tests/test_dictation.py
git commit -m "feat(sidecar): Parakeet remote-dictation sidecar (PCM over stdin)"
```

---

## Task 6: Desktop sidecar spawn adapter

**Files:**
- Create: `apps/desktop/src/main/dictation/dictation-sidecar.ts`

**Interfaces:**
- Consumes: `resolveSidecarPaths` from `../voice/sidecar-paths`; node `child_process`.
- Produces (used by Task 8):
  - `interface DictationSidecarHandle { onEvent(cb): void; onExit(cb): void; onStderr(cb): void; sendAudio(pcmBase64: string): void; end(): void; reset(): void; shutdown(): void; kill(signal?): void }`
  - `type DictationEvent = { type: 'ready' } | { type: 'interim'; text: string } | { type: 'final'; text: string } | { type: 'error'; code: string; message: string }`
  - `type DictationSidecarFactory = () => DictationSidecarHandle`
  - `spawnDictationSidecar(): DictationSidecarHandle`

- [ ] **Step 1: Implement the adapter**

Create `apps/desktop/src/main/dictation/dictation-sidecar.ts`:

```ts
// Spawns the Python dictation sidecar at
// `~/.orchestra/voice-venv/bin/python apps/desktop/voice-sidecar/dictation.py`
// and adapts child_process IO to the DictationSidecarHandle contract. Mirrors
// voice/python-sidecar.ts; reuses the same venv + sidecar dir (already shipped
// via electron-builder extraResources).

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { resolveSidecarPaths } from '../voice/sidecar-paths'

export type DictationEvent =
  | { type: 'ready' }
  | { type: 'interim'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: string; message: string }

export interface DictationSidecarHandle {
  onEvent(cb: (event: DictationEvent) => void): void
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
  onStderr(cb: (line: string) => void): void
  sendAudio(pcmBase64: string): void
  end(): void
  reset(): void
  shutdown(): void
  kill(signal?: NodeJS.Signals): void
}

export type DictationSidecarFactory = () => DictationSidecarHandle

export function spawnDictationSidecar(): DictationSidecarHandle {
  const paths = resolveSidecarPaths()
  const script = join(paths.sidecarDir, 'dictation.py')

  const child = spawn(paths.venvPython, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  }) as ChildProcessByStdio<Writable, Readable, Readable>

  const eventListeners: Array<(e: DictationEvent) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const stderrListeners: Array<(line: string) => void> = []

  let stdoutBuf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.type === 'string') {
          for (const fn of eventListeners) fn(parsed as DictationEvent)
        }
      } catch {
        // Drop malformed lines rather than crash the orchestrator.
      }
    }
  })

  let stderrBuf = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx)
      stderrBuf = stderrBuf.slice(idx + 1)
      for (const fn of stderrListeners) fn(line)
    }
  })

  child.on('exit', (code, signal) => {
    for (const fn of exitListeners) fn(code, signal)
  })
  child.on('error', (err) => {
    for (const fn of stderrListeners) fn(`spawn error: ${err.message}`)
  })

  const send = (command: object) => {
    try {
      child.stdin.write(JSON.stringify(command) + '\n')
    } catch {
      // child went away mid-write; the exit handler will fire
    }
  }

  return {
    onEvent(cb) { eventListeners.push(cb) },
    onExit(cb) { exitListeners.push(cb) },
    onStderr(cb) { stderrListeners.push(cb) },
    sendAudio(pcmBase64) { send({ type: 'audio', pcm: pcmBase64 }) },
    end() { send({ type: 'end' }) },
    reset() { send({ type: 'reset' }) },
    shutdown() { send({ type: 'shutdown' }) },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      try { child.kill(signal) } catch {}
    },
  }
}
```

- [ ] **Step 2: Typecheck the desktop main**

Run: `cd apps/desktop && npx tsgo --noEmit -p tsconfig.node.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/dictation/dictation-sidecar.ts
git commit -m "feat(desktop): dictation sidecar spawn adapter"
```

---

## Task 7: Desktop chunk-ordering helper

**Files:**
- Create: `apps/desktop/src/main/dictation/dictation-chunks.ts`
- Test: `apps/desktop/src/main/dictation/dictation-chunks.test.ts`

**Interfaces:**
- Produces (used by Task 8):
  - `interface RawChunk { seq: number; pcm: string }`
  - `orderChunks(rows: RawChunk[], afterSeq: number): RawChunk[]` — returns rows with `seq > afterSeq`, sorted ascending, de-duplicated by `seq`.
  - `maxSeq(rows: RawChunk[], fallback: number): number` — highest seq present, or `fallback` when empty.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/dictation/dictation-chunks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { maxSeq, orderChunks } from './dictation-chunks'

describe('orderChunks', () => {
  it('sorts ascending, drops <= afterSeq, and de-dups by seq', () => {
    const rows = [
      { seq: 3, pcm: 'c' },
      { seq: 1, pcm: 'a' },
      { seq: 3, pcm: 'c-dup' },
      { seq: 2, pcm: 'b' },
      { seq: 0, pcm: 'old' },
    ]
    expect(orderChunks(rows, 0)).toEqual([
      { seq: 1, pcm: 'a' },
      { seq: 2, pcm: 'b' },
      { seq: 3, pcm: 'c' },
    ])
  })
})

describe('maxSeq', () => {
  it('returns the highest seq', () => {
    expect(maxSeq([{ seq: 1, pcm: 'a' }, { seq: 5, pcm: 'e' }], -1)).toBe(5)
  })
  it('returns the fallback when empty', () => {
    expect(maxSeq([], -1)).toBe(-1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/dictation/dictation-chunks.test.ts`
Expected: FAIL — cannot resolve `./dictation-chunks`.

- [ ] **Step 3: Implement the helper**

Create `apps/desktop/src/main/dictation/dictation-chunks.ts`:

```ts
// Pure helpers for assembling dictation audio chunks pulled from Convex. The
// orchestrator polls getDictationChunks(afterSeq); rows can arrive out of order
// or duplicated across overlapping polls, so we sort + de-dup before feeding the
// sidecar in strict seq order.

export interface RawChunk {
  seq: number
  pcm: string
}

export function orderChunks(rows: RawChunk[], afterSeq: number): RawChunk[] {
  const bySeq = new Map<number, RawChunk>()
  for (const r of rows) {
    if (r.seq > afterSeq && !bySeq.has(r.seq)) bySeq.set(r.seq, r)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function maxSeq(rows: RawChunk[], fallback: number): number {
  let m = fallback
  for (const r of rows) if (r.seq > m) m = r.seq
  return m
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/dictation/dictation-chunks.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/dictation/dictation-chunks.ts apps/desktop/src/main/dictation/dictation-chunks.test.ts
git commit -m "feat(desktop): pure chunk-ordering helper for dictation"
```

---

## Task 8: Desktop dictation orchestrator + wiring

**Files:**
- Create: `apps/desktop/src/main/dictation/dictation-orchestrator.ts`
- Modify: `apps/desktop/src/main/index.ts` (start the orchestrator)

**Interfaces:**
- Consumes: `getRemoteClient`, `isRemoteBridgeEnabled` from `../remote-bridge`; `DEVICE_SECRET` from `../convex-config`; `getDaemonClient` from `../daemon-client`; `spawnDictationSidecar`, `DictationSidecarHandle` (Task 6); `orderChunks`, `maxSeq` (Task 7); `anyApi.remoteDictation.*` (Task 1).
- Produces: `startDictationOrchestrator(): void`, `stopDictationOrchestrator(): void`.

- [ ] **Step 1: Implement the orchestrator**

Create `apps/desktop/src/main/dictation/dictation-orchestrator.ts`:

```ts
// Glue between Convex dictation rows and the Parakeet sidecar. Subscribes to
// pendingDictation; for the active utterance it polls audio chunks, feeds them
// to a single warm sidecar (model stays loaded between utterances), mirrors the
// interim transcript back to the phone, and on the final pass injects the text
// into the agent PTY via the same daemon.write path remote.sendCommand uses.

import { anyApi } from 'convex/server'
import { DEVICE_SECRET } from '../convex-config'
import { getDaemonClient } from '../daemon-client'
import { getRemoteClient, isRemoteBridgeEnabled } from '../remote-bridge'
import { createResubscriber, type Resubscriber } from '../remote-bridge-resubscribe'
import { maxSeq, orderChunks, type RawChunk } from './dictation-chunks'
import { spawnDictationSidecar, type DictationSidecarHandle } from './dictation-sidecar'

const POLL_MS = 150

interface ActiveDictation {
  dictationId: string
  sessionId: string
  afterSeq: number
  ended: boolean      // web pressed release; drain remaining chunks then end()
  finalized: boolean  // sidecar emitted final; guard against double-injection
}

let sidecar: DictationSidecarHandle | null = null
let current: ActiveDictation | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let pendingSub: Resubscriber | null = null
let started = false

function ensureSidecar(): DictationSidecarHandle {
  if (sidecar) return sidecar
  const sc = spawnDictationSidecar()
  sc.onEvent((event) => {
    if (event.type === 'interim') {
      if (current && !current.finalized) {
        void getRemoteClient().mutation(anyApi.remoteDictation.setDictationInterim, {
          secret: DEVICE_SECRET,
          dictationId: current.dictationId,
          interimText: event.text,
        })
      }
    } else if (event.type === 'final') {
      if (current && !current.finalized) {
        const { dictationId, sessionId } = current
        current.finalized = true
        const text = event.text.trim()
        // Inject WITHOUT a trailing Enter — review-then-Enter (Global Constraints).
        if (text) getDaemonClient().write(sessionId, text)
        const c = getRemoteClient()
        void c.mutation(anyApi.remoteDictation.finalizeDictation, {
          secret: DEVICE_SECRET, dictationId, finalText: text,
        })
        void c.mutation(anyApi.remoteDictation.deleteDictationChunks, {
          secret: DEVICE_SECRET, dictationId, throughSeq: current.afterSeq,
        })
        current = null
      }
    } else if (event.type === 'error') {
      console.error('[dictation] sidecar error', event.code, event.message)
    }
  })
  sc.onStderr((line) => console.error('[dictation] sidecar stderr:', line))
  sc.onExit((code) => {
    console.error('[dictation] sidecar exited', code)
    sidecar = null
  })
  sidecar = sc
  return sc
}

// Pick the newest pending row as the active utterance. A new dictationId
// supersedes any in-flight one (single user; serialize).
function onPending(rows: Array<{ dictationId: string; sessionId: string; status: string }>): void {
  const newest = rows[rows.length - 1]
  if (!newest) return
  if (!current || current.dictationId !== newest.dictationId) {
    const sc = ensureSidecar()
    sc.reset()
    current = {
      dictationId: newest.dictationId,
      sessionId: newest.sessionId,
      afterSeq: -1,
      ended: false,
      finalized: false,
    }
  }
  if (current && current.dictationId === newest.dictationId && newest.status === 'ended') {
    current.ended = true
  }
}

async function poll(): Promise<void> {
  if (!current || current.finalized) return
  const c = getRemoteClient()
  let rows: RawChunk[] = []
  try {
    rows = (await c.query(anyApi.remoteDictation.getDictationChunks, {
      secret: DEVICE_SECRET,
      dictationId: current.dictationId,
      afterSeq: current.afterSeq,
    })) as RawChunk[]
  } catch (err) {
    console.error('[dictation] getDictationChunks failed', err)
    return
  }
  const ordered = orderChunks(rows, current.afterSeq)
  const sc = ensureSidecar()
  for (const ch of ordered) sc.sendAudio(ch.pcm)
  if (ordered.length > 0) current.afterSeq = maxSeq(ordered, current.afterSeq)
  // Once the phone has released AND this poll drained everything, finalize.
  if (current.ended && ordered.length === 0) {
    current.ended = false // guard: only fire end() once
    sc.end()
  }
}

export function startDictationOrchestrator(): void {
  if (started) return
  if (!isRemoteBridgeEnabled()) {
    console.log('[dictation] disabled (no DEVICE_SECRET)')
    return
  }
  started = true
  // Mirror remote-bridge: wrap onUpdate in a Resubscriber so the previous handle
  // is always disposed before a new one is created (a leak would double-apply).
  pendingSub = createResubscriber(() =>
    getRemoteClient().onUpdate(
      anyApi.remoteDictation.pendingDictation,
      { secret: DEVICE_SECRET },
      (rows: Array<{ dictationId: string; sessionId: string; status: string }>) => onPending(rows),
      (err: Error) => console.error('[dictation] pendingDictation subscription error', err),
    ),
  )
  pendingSub.resubscribe()
  pollTimer = setInterval(() => { void poll() }, POLL_MS)
  console.log('[dictation] orchestrator started')
}

export function stopDictationOrchestrator(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  try { pendingSub?.stop() } catch {}
  pendingSub = null
  sidecar?.shutdown()
  sidecar?.kill()
  sidecar = null
  current = null
  started = false
}
```

- [ ] **Step 2: Start the orchestrator from `index.ts`**

In `apps/desktop/src/main/index.ts`:

(a) Add the import next to the other main-process imports (near line 45 where `startRemoteBridge` is imported):

```ts
import { startDictationOrchestrator } from './dictation/dictation-orchestrator'
```

(b) Call it immediately after `startRemoteBridge(mainWindow)` (line 400):

```ts
  startRemoteBridge(mainWindow)
  startDictationOrchestrator()
```

- [ ] **Step 3: Typecheck the desktop main**

Run: `cd apps/desktop && npx tsgo --noEmit -p tsconfig.node.json`
Expected: no errors.

If the `onUpdate` return type doesn't expose `dispose`, the `as unknown as { dispose?: () => void }` cast already tolerates it (the existing `remote-bridge.ts` wraps `onUpdate` in `createResubscriber`; here a direct handle is fine because the orchestrator lives for the whole app session).

- [ ] **Step 4: Run the full desktop + backend + web test suites**

Run:
```bash
cd apps/desktop && npx vitest run src/main/dictation
cd ../backend && bun test convex/dictation-logic.test.ts
cd ../desktop/voice-sidecar && python -m pytest tests/test_dictation.py -q
cd ../../web && npx vitest run src/lib/dictation.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Manual end-to-end verification**

Prerequisites: `MAIN_VITE_DEVICE_SECRET` set for the desktop, the voice venv present (`~/.orchestra/voice-venv` with `parakeet-mlx`), and the web app deployed/running against the same Convex deployment.

1. Start the desktop app (`cd apps/desktop && npm run dev`) and confirm the log line `[dictation] orchestrator started`.
2. Open the web mirror on your phone, sign in, and open a session with a focused agent input.
3. Press and hold the **🎤 Talk** button and speak a sentence. Confirm: the overlay shows `Listening…` then live interim text; the desktop log shows the sidecar `ready` then `interim`/`final`.
4. Release. Confirm the final transcript appears in the agent input on the desktop **without** auto-submitting, and the overlay clears.
5. Press **Enter** (the existing key) to send it to the agent.
6. Deny mic permission once and confirm the overlay shows the error instead of hanging.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/dictation/dictation-orchestrator.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): dictation orchestrator + startup wiring"
```

---

## Spec deltas (v1 simplifications)

- **Button disabled-on-offline:** the spec calls for the Talk button to render disabled (with a reason) when the desktop is offline, the session isn't mirrored, or the sidecar is down. v1 keeps the button always enabled and surfaces only **mic-permission** failures in the overlay; a dead desktop manifests as the overlay staying on "Listening…" with no transcript arriving (and the orphaned chunks self-prune after 5 min via `pruneRemote`). Gating the button on desktop presence (remoteState freshness) is a small follow-up, deferred here to avoid coupling the button to the mirror-liveness signal in this pass.

## Deployment note

Per the project's mirror-fix deploy order (backend → desktop → web), ship in this order:
1. **Backend** — `cd apps/backend && npx convex deploy` (adds the dictation tables + functions; backward-compatible).
2. **Desktop** — build/install the app with the new orchestrator + `dictation.py`.
3. **Web** — deploy via the manual Vercel CLI flow (the web mirror is not git-deployed).

The first dictation after a desktop start pays a one-time Parakeet model-load cost (a few seconds); subsequent utterances reuse the warm sidecar. If that cold start is annoying, a later optimization is to call `ensureSidecar()` once at orchestrator start to pre-warm — deferred (YAGNI) for v1.
