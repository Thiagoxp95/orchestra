# Mobile Fit Reflow + Desktop Restore — Implementation Plan

> **For agentic workers:** Implement task-by-task. This change touches the shared PTY
> mirror — a subsystem that has garbled/frozen before (see `orchestra-mirror-seq-invariant`
> memory and the emphatic comments at `remote-bridge.ts:345-351,427-432`). **Verify with a
> real phone against prod Convex before flipping the gate on.** Steps use `- [ ]`.

**Goal:** Phone/web terminal reflows to a readable phone-sized geometry; desktop shows a
"Your phone left this at phone size" banner and auto-restores desktop geometry on focus.

**Design spec:** `docs/superpowers/specs/2026-07-22-mobile-fit-reflow-design.md` (read it
first — the "Why the naive version is dangerous" section is non-negotiable).

## Global constraints (apply to every task)

- **One writer to the PTY.** Only the desktop renderer's autofit calls
  `api.resizeTerminal`. The phone publishes a *desired* size as state; it never sends
  `resize`. The bridge's ignored-`resize` guard stays.
- **Gate default OFF.** `settings.mobileFit.enabled` defaults `false`. With it off, every
  new path is a no-op and behavior is byte-for-byte today's. This must hold after every
  task — the gate-off regression test is the acceptance gate for landing.
- **seq stays monotonic.** No new path resets `chunkSeq`. Reclaim reuses the existing
  `attach()`/`headSeq` priming; it never re-inits seq to 0.
- **Additive state only.** `mobileWant`/`fitOwner` are optional; absence ⇒ `desktop`
  owner ⇒ today's behavior. Old web clients and old mirrored rows keep working.

---

### Task 1: Mirrored state shape + sanitize (backend + bridge types)

- [ ] Document the two new optional fields on the session object where the mirror shape is
      typed: `SafeSession` in `apps/desktop/src/main/remote-bridge-sanitize.ts:62-76` —
      add `mobileWant?: {cols:number; rows:number}` and `fitOwner?: 'desktop'|'mobile'`.
- [ ] Sanitize them in the sanitize path (numbers finite & sane via the existing
      geometry bounds; `fitOwner` one of the two literals or dropped).
- [ ] `apps/backend/convex/remote.ts` `pushRemoteState` (line 21-51): confirm it passes
      `sessions` through untouched (it does — `v.any()`); add a one-line comment noting the
      two new per-session fields so the shape is discoverable. No schema migration.
- [ ] Unit test: sanitize drops malformed `mobileWant`/`fitOwner`, keeps valid ones.

### Task 2: The gate (desktop setting)

- [ ] Add `mobileFit: { enabled: boolean }` to the desktop settings type (find the
      settings shape near `apps/desktop/src/shared/types.ts` and the settings store), default
      `false`. Persist like other settings.
- [ ] Add a toggle in desktop Settings UI ("Reflow terminals to phone size on mobile"),
      wired to the setting. Copy cue from Orca's `MobileAutoRestoreFitSection.tsx`.
- [ ] Expose the current value to the bridge (main) — read it wherever the bridge can see
      settings, or push it into the bridge on change.

### Task 3: Web publishes a readable phone-fit (inert until desktop honors it)

- [ ] In `apps/web/src/components/Terminal.tsx`, add a `computePhoneFit()` that measures a
      cell at `TERMINAL_FONT_SIZE` and returns `{cols, rows}` for the viewport, clamped to
      sane bounds (2..2000 / 1..2000).
- [ ] Send `sendCommand('claimFit', {cols, rows})` on attach and on the existing debounced
      ResizeObserver (line 255). Do **not** send `resize`.
- [ ] Leave the adopt/`rescale` path untouched — it already renders authoritative
      `cols/rows` 1:1 when they arrive phone-sized.
- [ ] Unit test `computePhoneFit` (given viewport + cell metrics → expected geometry).

### Task 4: Bridge arbitration (main) — signal, don't resize

- [ ] `apps/desktop/src/main/remote-bridge.ts` `applyOne`: add `case 'claimFit'` — store
      `mobileWant[sessionId]`; if gate ON and a mobile client is attached, set
      `fitOwner[sessionId]='mobile'`, `webContents.send('remote-mobile-fit',
      {sessionId, cols, rows, owner:'mobile', active:true})`, and debounced `pushState()`.
      **Do not** call `daemon.resize` here.
- [ ] `detach`: if owner is `mobile`, keep it (hold) and send `remote-mobile-fit
      {sessionId, owner:'mobile', active:false}` so the renderer flips to the banner.
- [ ] Add a reclaim IPC handler (`terminal-reclaim-fit` in `src/main/index.ts`) that clears
      `fitOwner`/`mobileWant` for a session (or all) and `pushState()`s.
- [ ] Keep the `resize` case ignored (unchanged).
- [ ] Pure-logic test `mobile-fit-arbitration.test.ts`: gate-off → no owner set; claim +
      attach → owner mobile; detach → owner held; reclaim → owner desktop.

### Task 5: Renderer override module + autofit park (single writer)

- [ ] New `apps/desktop/src/renderer/src/lib/mobile-fit-overrides.ts` — a
      `Map<sessionId,{owner,cols,rows,active}>` with `onChange` listeners, fed by an
      `remote-mobile-fit` IPC subscription (mirror Orca's module of the same name).
- [ ] `hooks/useTerminal.ts:116` autofit wiring: `isPaused()` also true when the active
      session's owner is `mobile`. On the first `mobile` claim for the active session, apply
      the phone `(cols,rows)` once via `api.resizeTerminal` (the single reflow write), then
      park (no further PTY resizes while parked).
- [ ] Verify `planPtyResize` still gates so parking never emits a resize.

### Task 6: Auto-reclaim on focus + the restore banner

- [ ] In `terminal-autofit.ts`, on `focus`/`visibilitychange`-visible: if active session
      owner is `mobile` **and** `active:false` (held), call `terminal-reclaim-fit`, un-pause,
      `reconcile('manual')` to re-fit desktop dims. Guard with a
      `shouldFocusMobileDriverAction`-style check so a background glance doesn't reclaim.
- [ ] New `apps/desktop/src/renderer/src/components/MobileFitBanner.tsx` — port the "held"
      branch of Orca's `MobileDriverOverlay.tsx`: title "Your phone left this at phone size",
      "Restore this terminal" (reclaim one) + "Restore all terminals" (reclaim all). Render in
      the terminal pane only when owner is `mobile` and not active.
- [ ] Wire the banner buttons to `terminal-reclaim-fit` (single / all).

### Task 7: Verify (needs a phone), then enable

- [ ] Run the manual test matrix from the design spec (gate-off regression FIRST).
- [ ] Deploy order: **backend → desktop → web**. Web is manual (`vercel` CLI); backend is
      `bunx convex deploy --prod`.
- [ ] Only after the matrix passes on a real phone: flip `mobileFit.enabled` default (or
      leave as an opt-in setting and just document it). Ship a release via `bun run release`
      so installed copies pick up the desktop half.

---

## Not in scope (follow-ups)

- Migrating `useMaestroTerminal.ts` to `attachTerminalAutoFit` so maestro honors mobile-fit.
- Orca's tri-state auto-restore setting (`off`/`hold`/`auto-restore`).
- Remembering per-session desktop geometry to restore an exact prior size (we re-fit fresh
  instead, which is simpler and correct for a single desktop).
