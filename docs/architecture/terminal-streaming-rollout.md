# Production terminal streaming rollout

Implemented September 11, 2026. The accepted behavior is automatic reflow to the active web viewport, with per-session control ownership.

## Shipped architecture

The daemon numbers UTF-8 output and resize events in one incarnation, retains a bounded contiguous event suffix, and captures checkpoints at an ordered parser boundary. The browser applies bytes outside React, acknowledges parser completion, and resumes its applied cursor after reconnect. A dedicated authenticated outbound WebSocket relay replaces Convex chunk rows for compatible sessions. Convex remains the identity and product metadata/control service.

The active web viewer controls the viewed PTY's grid. Passive viewers adopt its geometry. Desktop activation reclaims that specific session. Delayed image and dictation input carries an original lease token checked at the actual write, and terminal query replies come from the authoritative headless emulator. Browser/desktop adapters distinguish generated replies from real keyboard/IME/paste input using xterm's input provenance.

Limits: 10,000 scrollback rows plus the viewport, 8 MiB/32,768 retained events per daemon session, 64 KiB unacknowledged bytes per viewer, 128 KiB pending browser bytes, 4 MiB escaped JSON checkpoints, and 32 relay viewers. Daemon parser pressure pauses its child pipe at128KiB and resumes at32KiB; the child propagates blocked stdout to node-pty. Retention expiration requests an explicit staged checkpoint, not arbitrary byte dropping. xterm markers preserve a retained reading line when the live buffer trims.

## Validation

- 110 daemon tests; includes atomic checkpoints/suffixes, split CSI/OSC/UTF-8, resize order, modes, saved cursors, tab stops, character sets, pending wrap, hyperlink/underline attributes, parser backpressure, and authoritative cursor replies.
- 7 real relay/host tests: authentication, routing, seed acknowledgements, independent credit, per-session leases, stale/duplicate input, delayed operation guards and old-daemon capability fallback.
- 462 web tests, including provenance, staged recovery, reconnect, marker anchoring, leases, input/paste and asynchronous ownership guards.
- Root workspace typechecks and production builds pass; root lint has existing warnings and no errors.
- Aside browser QA uses a disposable real node-pty fixture with the production daemon modules, host, relay and web client. 5,000-row scenario passed reading-anchor stability, offset reconnect, cell/attribute/cursor/mode comparison, alternate/normal screens, automatic82→50column reflow, controller reclaim, and independent slow-viewer delivery.
- Long scenario generated110,500 additional rows. Live buffer stayed10022rows, ring8387970bytes, pending parser bytes0 after drain. Retained row206389 stayed anchored as its viewport index correctly moved9000→8500 after trim, survived reconnect, and two new viewers hydrated fresh10022-row checkpoints with no pending bytes. Total synthetic output at that point was14346230bytes.

These results verify the browser and production components, not native Electron GUI behavior or phone/Safari performance. No comparative FPS or WAN-latency claim is made. Harness and reproducible scripts live in `apps/desktop/experiments/terminal-stream`; they are excluded from release packaging.

## Compatibility and operating boundary

Existing live daemons remain running across desktop upgrades. A preserved older daemon reports no stream capability, so the web uses the earlier transport for those sessions. The new daemon/transport activates when the old daemon exits through its normal process/system lifecycle; this release never kills existing PTYs to force activation.

The relay runs on one dedicated Fly machine, independently of the persistent Convex database. It has an exact origin allowlist and revalidates viewer authorization every minute. Operations and rollback are documented in `infra/terminal-relay/README.md`.

The live history and replay suffix are bounded. This release does not implement the proposal's separate indexed archive browser or change the terminal engine to Ghostty/Rust. Older history beyond retention expires explicitly. Unsupported checkpoint states (such as a currently incomplete DCS or protected cells) are rejected instead of inventing parser state. The xterm6 internal compatibility seams and MIT ANSI serializer extension are tested and must be revalidated on an engine upgrade.
