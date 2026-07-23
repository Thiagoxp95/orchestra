# Mobile Fit Reflow + Desktop Restore — Design Spec

**Status:** Design. Gated, default-OFF. Requires a real phone to verify (mirror change).

**Goal:** On the phone/web mirror, a terminal should reflow to a *readable* phone-sized
geometry (fewer columns, real font) instead of the whole desktop-width terminal
CSS-shrunk to tofu-height text. When the phone session ends, the desktop shows a
"Your phone left this at phone size" banner and restores desktop geometry — and,
per Orchestra's twist, **auto-restores the moment the desktop terminal regains
focus**, so the manual banner is a fallback, not the primary path.

Reference: `stablyai/orca` — `MobileDriverOverlay.tsx` (the banner), `mobile-fit-overrides.ts`
(the ownership state machine). We adapt Orca's proven *park-don't-fight* idea to
Orchestra's architecture without inheriting Orca's phone-owns-the-PTY inversion.

---

## Why the naive version is dangerous (read before touching this)

Orchestra deliberately makes the phone a **pure viewer**: it adopts the desktop's
`(cols, rows)` and CSS-scales locally, and the bridge **drops** any `resize` the web
sends. The reason is written into the code in two places and must be respected:

- `apps/desktop/src/main/remote-bridge.ts:345-351` — the `resize` case is
  "**Intentionally ignored** … it fights the desktop's ResizeObserver and **garbles
  the mirror**."
- `apps/desktop/src/main/remote-bridge.ts:427-432` — attach snapshots at the live
  size with no reflow, avoiding "the desktop/phone tug-of-war over the PTY width
  that left the mirror garbled."

There is exactly **one** writer to the shared PTY today: the desktop renderer's
autofit → `api.resizeTerminal` → `daemon.resize`. **This spec keeps it that way.**
The phone never resizes the PTY. Instead it publishes a *desired* size as passive
state; the desktop (the sole writer) decides whether to honor it. Two writers on one
PTY is the failure mode; we do not introduce it.

Also load-bearing (see `orchestra-mirror-seq-invariant` memory): a PTY resize must
**not** reset the per-session chunk `seq`. Resizing does not touch `chunkSeq` today,
and nothing here changes that — but any re-seed/clearChunks on reclaim MUST keep seq
monotonic (reuse the existing `attach()` path, which already primes from `headSeq`).

---

## Model: single-writer, desktop-arbitrated fit ownership

Per session, a **fit owner**: `desktop` (default) or `mobile`. Stored in the mirrored
session state so both sides agree. State transitions:

```
                phone attaches, desktop mobileFit=ON, publishes mobileWant
   desktop ───────────────────────────────────────────────────────────▶ mobile
      ▲                                                                     │
      │  desktop terminal regains focus (auto)                             │ phone detaches
      │  OR "Restore this terminal" / "Restore all terminals" (manual)     │ (owner HOLDS = mobile)
      └─────────────────────────────────────────────────────────────────◀─┘
```

- **desktop (default / today):** desktop autofit owns geometry; PTY sized to desktop
  container; phone adopts + scales. Zero behavior change from today.
- **mobile (active):** a phone is attached, wants a phone-fit size. The **desktop**
  (still the only writer) resizes the PTY to the phone's desired size and **pauses its
  own autofit** for that session (park-don't-fight). The desktop terminal, if visible,
  renders the mirror at phone dims and shows a quiet "phone driving" affordance.
- **mobile (held):** phone detached but owner stays `mobile` (Orca's "hold"), so the
  PTY keeps the phone size instead of snapping back mid-glance. Desktop shows the loud
  "Your phone left this at phone size" banner.
- **restore:** desktop reclaims → owner `desktop`, autofit un-pauses and re-fits →
  PTY resized back to desktop dims. Triggered automatically on desktop terminal focus,
  or manually via the banner buttons.

### New mirrored fields (additive, backward-compatible)

Per session object in `remoteState.sessions[id]` (currently `{label, processStatus,
cwd, workspaceId, actionIcon?, cols?, rows?}`):

- `mobileWant?: { cols: number; rows: number }` — the phone's desired phone-fit size.
  Written by the **web** (via a new `sendCommand` kind, see below); pure state, never
  a PTY resize by itself.
- `fitOwner?: 'desktop' | 'mobile'` — arbitration result. Written by the **desktop
  bridge** only. Absent ⇒ `desktop` (so old data and old clients behave as today).

`cols`/`rows` remain the **authoritative** PTY geometry the viewer adopts. When
`fitOwner === 'mobile'` and the desktop has acted, `cols`/`rows` already equal the
phone size, so the viewer needs no special case — it just adopts them as always.

The Convex `schema.ts` `remoteState.sessions` is `v.any()` (line 88-95), so no schema
migration is required; document the shape in `remote-bridge-sanitize.ts` `SafeSession`
(line 62-76) and sanitize the two new fields there.

---

## The gate: one desktop setting, default OFF

`settings.mobileFit.enabled: boolean` (default `false`). Lives on the **desktop** (it
is the arbiter). While `false`:

- The bridge ignores `mobileWant` and never sets `fitOwner` — behavior is byte-for-byte
  today's.
- The web may still compute and publish `mobileWant` (harmless passive state); with the
  gate off the desktop simply doesn't act, so **the web change ships inert**.

This is what makes the whole feature safe to land before it is verified: with the gate
off, no code path that resizes the PTF differently from today can execute. Flipping the
setting on is the single act that activates it, and it can be flipped back off instantly
if the mirror misbehaves.

Optional follow-up (Orca parity): a tri-state — `off` / `hold` (default-on once trusted)
/ `auto-restore` — mirroring Orca's `MobileAutoRestoreFitSection`. Out of scope for v1.

---

## Web: compute a readable phone-fit and publish it

`apps/web/src/components/Terminal.tsx` today adopts `(cols,rows)` and scales by
`Math.min(availW/naturalW, availH/naturalH)` (line 127) — a 120-col PTY on a 390px
phone becomes ~3px/char. New path (only changes behavior once the desktop honors it):

1. Compute a phone-fit geometry from the viewport at a **readable** cell size: measure
   one cell at `TERMINAL_FONT_SIZE` (reuse a hidden measure span or xterm's
   `_core._charSizeService` like the desktop autofit does), then
   `wantCols = floor(availW / cellW)`, `wantRows = floor(availH / cellH)`, clamped by
   `isSaneGeometry` (2..2000 cols, 1..2000 rows — reuse the desktop helper's bounds).
2. Publish it: `sendCommand('claimFit', { cols: wantCols, rows: wantRows })` on attach
   and on debounced viewport resize (reuse the existing 80ms ResizeObserver at line
   255). This only writes `mobileWant`; it does **not** send `resize`.
3. Keep adopting authoritative `cols/rows` exactly as today. When the desktop honors the
   claim, `cols/rows` arrive already phone-sized and the existing `applyGeometry` +
   `rescale` render them 1:1 (scale ≈ 1). When the desktop does not (gate off / desktop
   focused), `cols/rows` stay desktop-size and today's shrink-to-fit is unchanged.

No `resize` command is ever sent; the ignored-`resize` guard in the bridge stays.

---

## Desktop bridge (main): arbitrate, never introduce a second writer

`apps/desktop/src/main/remote-bridge.ts`:

- New `sendCommand` kind `claimFit` in `applyOne` (near line 345): record
  `mobileWant[sessionId] = {cols, rows}`; if the gate is on and a mobile client is
  attached to this session, set `fitOwner[sessionId] = 'mobile'` and **tell the renderer**
  (`mainWindow.webContents.send('remote-mobile-fit', {sessionId, cols, rows, owner:
  'mobile'})`) — the renderer performs the actual `daemon.resize` via its normal autofit
  path (single writer preserved). Debounce-push the new fields into `remoteState`.
- On `detach`: if `fitOwner[sessionId] === 'mobile'`, **hold** it (do nothing to owner)
  and push a `remote-mobile-fit` with `active:false` so the renderer flips the banner
  from "phone driving" to "left at phone size".
- New renderer→main path for reclaim: an IPC (`terminal-reclaim-fit`) that clears
  `fitOwner`/`mobileWant` for a session and pushes state. Called by the renderer after it
  re-fits to desktop dims (so the authoritative `cols/rows` update in the same beat).
- Sanitize `mobileWant`/`fitOwner` in `remote-bridge-sanitize.ts`.

Crucially, the bridge **still never calls `daemon.resize` for a phone-driven size** — it
signals the renderer, which is the one writer. If the desktop window is closed/hidden and
the renderer can't act, the PTY simply stays desktop-size and the phone scales (today's
behavior) — a safe degradation, not a broken mirror.

---

## Desktop renderer: park, banner, auto-reclaim-on-focus

`apps/desktop/src/renderer/src/hooks/terminal-autofit.ts` +
`hooks/useTerminal.ts`:

- A renderer-side per-session fit map fed by `remote-mobile-fit` IPC (mirror Orca's
  `mobile-fit-overrides.ts` module — a small `Map<sessionId, {owner, cols, rows,
  active}>` with a change listener).
- `attachTerminalAutoFit` already exposes `isPaused()` (used for maestro). Extend the
  caller in `useTerminal.ts:116` so `isPaused()` also returns true when the active
  session's fit owner is `mobile`. While paused, the desktop does not resize the PTY —
  it parks. When a `mobile` claim first lands, apply the phone `(cols,rows)` to the PTY
  **once** via the normal `api.resizeTerminal` (the single write that reflows it), then
  park.
- **Auto-reclaim on focus (the Orchestra twist):** autofit already listens to window
  `focus` → `reconcile('focus')` (line 187-189). Add: on `focus` (and
  `visibilitychange` to visible), if the active session's owner is `mobile` and *no
  mobile client is currently active* (held state), clear the override (call
  `terminal-reclaim-fit`), un-pause, and `reconcile('manual')` to re-fit to desktop dims.
  Guard: only when the desktop terminal is actually the focused surface (reuse
  `shouldFocusMobileDriverAction`-style checks) so focusing the composer doesn't yank a
  terminal the user is only glancing at. The banner remains for the case where the user
  wants to keep watching at phone size and restore explicitly.
- **Banner:** port `MobileDriverOverlay.tsx`'s "held" branch (`hasFitOverride`) as a
  small overlay in the desktop terminal pane: title "Your phone left this at phone size",
  buttons "Restore this terminal" (reclaim this session) and "Restore all terminals"
  (reclaim every held session). Show it only when owner is `mobile` and not active.

Note: `useMaestroTerminal.ts` is the un-migrated autofit site (`terminal-autofit.ts:9`).
It hand-rolls the same measure/fit; if maestro must honor mobile-fit too, migrate it to
`attachTerminalAutoFit` first (separate task, out of scope here).

---

## Deploy order & test plan (why this needs a phone)

Deploy order is load-bearing (memory `orchestra-mirror-seq-invariant`): **backend →
desktop → web**. `mobileWant`/`fitOwner` are additive so backend-first is safe; the web
change is inert until the desktop honors it, so web-last is safe.

Cannot be verified without a real phone against prod Convex. Manual test matrix:

1. Gate OFF (default): phone mirror identical to today; desktop unaffected. **Regression
   gate — must pass before enabling.**
2. Gate ON, phone attaches: terminal reflows to readable phone width; `htop`/agent TUI
   reflows (not shrinks); desktop terminal parks at phone size, no resize war (watch for
   flicker/garble — the exact failure the bridge comments warn about).
3. Phone detaches: PTY holds phone size; desktop shows the banner.
4. Desktop terminal focus: auto-restores to desktop dims; banner clears.
5. "Restore all terminals" with two phone-held sessions: both reclaim.
6. Two viewers (phone + web): seq stays monotonic across the reflow; neither freezes.

Automated coverage to add alongside: extend `remote-bridge-seed-geometry.test.ts` and a
new `mobile-fit-arbitration.test.ts` (pure bridge logic — owner transitions, hold on
detach, gate-off no-op), plus a web unit test for the phone-fit geometry computation.

---

## Files touched (summary)

| Area | File | Change |
|---|---|---|
| Backend | `apps/backend/convex/remote.ts` | accept/passthrough `mobileWant`,`fitOwner` (schema is `v.any()`, no migration) |
| Desktop main | `remote-bridge.ts`, `remote-bridge-sanitize.ts` | `claimFit` kind, arbitration, hold-on-detach, reclaim IPC, sanitize |
| Desktop main | `src/main/index.ts` | `terminal-reclaim-fit` IPC, forward `remote-mobile-fit` |
| Desktop renderer | `terminal-autofit.ts`, `useTerminal.ts`, new `mobile-fit-overrides.ts` | pause-while-mobile, apply-once, auto-reclaim-on-focus |
| Desktop renderer | new `MobileFitBanner.tsx` | "left at phone size" restore banner |
| Desktop settings | settings type + a toggle | `mobileFit.enabled`, default false |
| Web | `apps/web/src/components/Terminal.tsx` | compute + publish `claimFit`; adopt authoritative geometry unchanged |

All gated behind `settings.mobileFit.enabled` (default false) so it lands inert.
