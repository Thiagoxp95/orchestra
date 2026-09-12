# Orchestra terminal infrastructure: external research

Research date: 2026-09-11. Scope: primary public documentation and upstream source only; no Orchestra source examined. Version and maturity statements describe the pages retrieved on this date, including moving `main` branches, and are not guarantees about a particular installed release. No comparative performance measurements were run.

## Recommendation

Treat the terminal as a persistent stateful session with two interchangeable viewers. Give one host process ownership of the PTY, ordered output, canonical geometry, and history. Electron and the browser should consume the same session contract and share an emulator/view implementation. Replacing the browser library alone cannot correct lost output, competing resizes, history resets, or client/server disagreement.

Choose between two substantial architectures, using the same recorded workload and acceptance tests:

1. **Shared emulator with an ordered VT byte stream.** Initially use xterm.js in Electron/browser with matching versions/options and a host-side headless instance for recovery. This has the clearest supported integration path. Give raw transport, snapshots, retention, and flow control their own modules. A Ghostty web adapter can compete behind the same contract.
2. **Host-authoritative terminal state with viewport deltas and paged history.** A Rust session service maintains screen/cells/history, and clients request rows and receive versioned changes. WezTerm is the strongest concrete reference. This gives tighter control over very large histories and slow clients, but requires substantially more rendering/protocol/selection/Unicode work unless adopting a complete compatible stack.

These are architectural recommendations inferred from the sources below, not measured conclusions about Orchestra. Do not combine raw VT writes and ad hoc rendered screen replacement concurrently: pick an explicit recovery transition and sequence boundary.

## What established projects do

### xterm.js: same browser/Electron terminal plus explicit flow control

The project supports modern browsers and Electron, supplies a WebGL addon, and documents `@xterm/headless` for maintaining state near the process and restoring clients after reconnection with its serialize addon. That makes it a realistic shared implementation rather than a web-only compromise. This does not establish that it is faster than Ghostty on Orchestra's workload. [xterm.js upstream README](https://github.com/xtermjs/xterm.js/)

`write` queues work and returns before parsing completes. The maintainers explicitly warn that fast producers can overwhelm buffers. Their documented WebSocket design sends application acknowledgments from completed terminal writes and applies watermarks at the producer. Merely placing a WebSocket between the PTY and renderer is insufficient. The guide includes historical throughput and buffer numbers; do not promote those into present-day product limits or benchmark claims. [xterm.js flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/)

The serialize API supports a chosen scrollback amount or row range and mode inclusion. It recommends restoring using the original rows/columns, then resizing if necessary, and restoring before opening the renderer to avoid drawing intermediate frames. The addon README still labels it experimental. Therefore use it behind a versioned recovery contract with conformance tests, not as a promised complete process/parser checkpoint. [serialize API](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/typings/addon-serialize.d.ts), [serialize README](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/README.md)

### ttyd and WeTTY: proven browser gateways, not automatic mirroring infrastructure

`ttyd` supplies a small cross-platform command gateway with libuv, WebGL2 and authentication options. It can run arbitrary commands. [ttyd README](https://github.com/tsl0922/ttyd)

Its upstream client imports xterm, sends binary WebSocket output/input messages and resize messages, and implements PAUSE/RESUME using pending terminal-write callbacks and high/low watermarks. Its reconnect handler resets the client terminal. This is an excellent transport/flow-control reference but not evidence of durable historical recovery for an existing Orchestra PTY. [ttyd terminal source](https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/xterm/index.ts)

WeTTY is a Node-based HTTP(S)/WebSocket terminal using xterm.js, commonly launching SSH to a host. It can be useful when the desired product really is a generic SSH browser gateway. Integrating it does not itself preserve an already-running Electron-owned terminal or reproduce its complete history. [WeTTY README](https://github.com/butlerx/wetty)

### WezTerm: the most relevant Rust architecture reference

WezTerm is a Rust terminal emulator and multiplexer with local/remote panes and native scrollback. SSH domains connect to a compatible remote WezTerm daemon; SSH is the channel beneath the multiplexer. The documentation still describes multiplexing as evolving and requires compatible versions. [WezTerm overview](https://wezterm.org/), [multiplexing documentation](https://wezterm.org/multiplexing.html)

Its actual protocol separates rendering changes from fetching rows. `GetPaneRenderChangesResponse` includes dirty row ranges, stable cursor position, geometry, sequence number and opportunistic row data. `GetLines` requests stable row ranges; there are separate scrollback-search requests. The source explicitly versions the codec for incompatible changes. This demonstrates a mature architectural pattern for remote scrollback, but is not a stable browser SDK that can simply replace xterm. [WezTerm codec source](https://raw.githubusercontent.com/wezterm/wezterm/main/codec/src/lib.rs)

A new Rust host could use WezTerm's `portable-pty` for cross-platform PTY abstraction. It supplies PTY/session I/O primitives, not web rendering or recovery. [portable-pty API](https://docs.rs/portable-pty/latest/portable_pty/)

### Rust terminal cores: useful building blocks with integration cost

`vt100` parses terminal bytes into an in-memory screen and can produce formatted contents or incremental changes. Its API documentation illustrates the distinction between a complete visible-screen representation and a diff. It is worth considering for a prototype or a deliberately limited compatibility target. Its existence does not establish support for every modern terminal feature used by coding agents. [vt100 API](https://docs.rs/vt100/latest/vt100/)

`alacritty_terminal` is a Rust library for building terminal emulators. Its manifest includes the parser and platform-specific terminal dependencies. It is not a browser renderer or a remote session product. A Rust backend or WASM path still needs rendering, history/recovery, input semantics and a compatibility assessment. Alacritty itself advises measuring one's actual workload instead of assuming benchmark throughput implies low latency or consistent frames. [alacritty_terminal API](https://docs.rs/alacritty_terminal/latest/alacritty_terminal/), [crate manifest](https://docs.rs/crate/alacritty_terminal/latest/source/Cargo.toml), [Alacritty README](https://github.com/alacritty/alacritty/blob/master/README.md)

### Ghostty and ghostty-web: real candidates, with concrete caveats

Ghostty's shared core is **Zig**, not Rust. Upstream now says `libghostty-vt` is available for Zig/C and macOS/Linux/Windows/WebAssembly, with proven terminal functionality but API signatures still changing. `libghostty-vt` focuses on terminal parsing/state. Native Ghostty's Metal/OpenGL renderer and native app integration are separate advantages, not something automatically inherited by compiling the parser to WASM. [Ghostty upstream README](https://github.com/ghostty-org/ghostty/blob/main/README.md?plain=1)

Coder's `ghostty-web` wraps a WASM build of Ghostty with an API aiming for xterm compatibility. It builds from patched Ghostty source and states an intention to consume upstream native WASM distribution when available. This is usable software, not merely a future proposal. Its retrieved main-branch package manifest reports 0.4.0; this is not a release recommendation. [ghostty-web README](https://github.com/coder/ghostty-web), [package manifest](https://raw.githubusercontent.com/coder/ghostty-web/main/package.json)

**Source-level concerns directly relevant to Orchestra:** the browser renderer uses Canvas2D. In `writeInternal`, a nonzero `viewportY` triggers `scrollToBottom()` on new output, and supplied write callbacks are scheduled with `requestAnimationFrame`. The inspected code thus needs particular scrutiny for reading old output during streaming and acknowledgment progress in background tabs. The public `write` also requires an open terminal, so xterm's restore-before-open advice is not directly portable. These are observations about the retrieved branch, not claims that every released version behaves identically. [renderer source](https://raw.githubusercontent.com/coder/ghostty-web/main/lib/renderer.ts), [terminal source](https://raw.githubusercontent.com/coder/ghostty-web/main/lib/terminal.ts)

The project has a regression test for stale cells appearing during repeated scroll growth with heavy ANSI style resets. This indicates active coverage of precisely relevant corner cases, not proof that current rendering is broken. [scroll-growth regression test](https://raw.githubusercontent.com/coder/ghostty-web/main/lib/viewport-corruption.test.ts)

Decision: include it in a bounded replay benchmark and compatibility spike. Do not promise that replacing the import fixes flicker, history, API compatibility or responsiveness. If it wins, use the same adapter in Electron and browser. Avoid a native desktop renderer plus unrelated browser renderer if exact behavioral equivalence is the primary requirement.

### SSH, Tailscale, and Mosh occupy different layers

SSH traditionally transports terminal bytes; it does not by itself specify durable remote terminal history or browser rendering. Mosh instead synchronizes current screen state, permitting intermediate output states to be skipped to preserve responsiveness. Its FAQ explicitly says only the visible terminal state is synchronized, so scrollback can be incomplete. Mosh is valuable architectural inspiration for slow-client recovery, but unsuitable as the sole history mechanism for Orchestra's large sessions. [Mosh design and FAQ](https://mosh.org/)

Tailscale SSH Console runs the Tailscale client, WireGuard, userspace networking and SSH client in browser WASM. Current documentation labels it beta, requires eligible tailnet admin roles, starts sessions from the Tailscale admin console and uses DERP relays for all Console traffic. It is not a standalone embeddable Orchestra terminal service. Tailscale can still be chosen underneath a custom session service for private reachability and access control; that choice is independent of scrollback and rendering. [Tailscale SSH Console documentation](https://tailscale.com/docs/features/tailscale-ssh/tailscale-ssh-console)

## Proposed protocol and history invariants

The following are engineering deductions/recommendations, rather than vendor promises:

- One session ID plus restart epoch identifies the authoritative PTY. Every output chunk has a contiguous byte range, with resize events in the same ordered event history. Preserve bytes, including partial Unicode and escape sequences.
- One controller owns PTY geometry and terminal replies. Mirrored viewers do not independently resize the process or echo duplicate device-status responses. If viewers have different available widths, choose explicit crop/scale/pan semantics; independent reflow cannot promise identical screen layout.
- Maintain a recoverable live terminal state, a bounded recent-output ring, and durable archived output/history separately. A browser mounting a session must not require replaying hours of output.
- Snapshot and catch-up must be atomic at an explicit event/byte boundary. Buffer subsequent output while snapshotting, restore once, apply precisely the suffix, then continue live. Test partial escape/Unicode boundaries: serialized visible cells are not necessarily complete hidden parser state.
- Per-viewer acknowledgment windows count bytes consistently and acknowledge parsing/application, not socket receipt. A slow observer should not indefinitely throttle the desktop controller: stop its stream and offer bounded catch-up or a fresh checkpoint. Durable capture must continue subject to explicit storage limits.
- Full-history retention is a storage policy, not a browser scrollback setting. Archive raw events for faithful replay and build versioned history indices/materialized rows from emulator semantics; plain newline splitting loses cursor rewrites and alternate-screen behavior. Preserve geometry/wrap metadata and define historical reflow policy.
- For unlimited-feeling scrollback, request pages around a stable row/history anchor, cap resident data, and keep live output from moving a user reading earlier text. A single continuous scroller backed by archived rows is a larger renderer integration project; do not pretend prepending arbitrary ANSI chunks to xterm is safe history pagination.
- Keep the terminal render lifecycle independent of React output state. The UI owns mounting and controls; a session/view adapter owns writes, dimensions, follow-tail and selection. Matching fonts, metrics, palettes, Unicode behavior and terminal modes are part of parity; bit-for-bit pixels across browsers and operating systems are a separate, stronger target.

## Validation before selecting the engine

Replay recorded, representative PTY output into baseline xterm/WebGL, Ghostty web, and (only if justified) a Rust/state-delta prototype. Include huge normal scrollback, cursor-rewriting agent TUIs, alternate screen, synchronized updates, soft-wrap/resize, wide/combining Unicode, selection while streaming, and background-tab suspend/resume. Compare emulator state plus screenshots at known checkpoints.

Measure first usable frame on attach/reconnect, dropped/duplicated output, input-to-visible response under sustained output, p95 frame time while scrolling, memory after repeated attach/detach and WebSocket queued bytes. Apply constrained bandwidth/latency and one slow secondary viewer. Require selection/scroll anchors to remain stable during new output and recovery. Set numerical budgets after capturing the desktop baseline; no library claim substitutes for this evidence.

## Concrete Rust relay implementation option

Use **Axum + Tokio** for a dedicated relay: Axum documents WebSocket upgrades and independently reading/writing a connection; Tokio supplies bounded `mpsc` channels and task ownership of a resource. Use a session actor and one bounded per-subscriber sender, plus a byte-budget semaphore because a message-count bound alone does not cap variable-size payload memory. This is a practical implementation recommendation based on the documented primitives, not a claim that Rust alone fixes the current bugs. [Axum WebSocket API](https://docs.rs/axum/latest/axum/extract/ws/index.html), [Tokio synchronization API](https://docs.rs/tokio/latest/tokio/sync/index.html)

For a Rust host initiating an outbound WSS connection to that relay, use **tokio-tungstenite**, which provides asynchronous client/server WebSocket streams and optional rustls/native-TLS integration. A TypeScript host can initially retain its current PTY/headless ownership and implement the same outbound protocol, avoiding an unnecessary simultaneous terminal-core rewrite. [tokio-tungstenite API](https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/)

A Tokio broadcast channel is not durable history: its lagging receivers can lose retained values and receive `Lagged`. Treat lag as a mandatory replay/resnapshot transition, never as permission to continue at a later byte offset. A bounded relay should route session frames and control messages; durable logs and checkpoints remain authoritative at the host. [Tokio broadcast semantics](https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html)

Operational tradeoff: this creates a service to deploy, route, monitor and reconnect. Implement session ownership/host routing and short-lived authorization using the existing control plane; do not turn every byte into a database mutation. ttyd/WeTTY reduce generic SSH-gateway implementation effort but do not provide this exact session/cursor/checkpoint contract. A Node WSS relay with the same semantics is also viable; use Rust for explicit concurrency/resource bounds and operational fit, not unmeasured speed claims.

## Pinned upstream references

GitHub's commits API resolved `coder/ghostty-web` main to **1858a5947767a3e1c9e98dbf53b2ff87fedb2aab**, committed 2026-06-28. The scrolling/callback and Canvas2D observations above can be reviewed at these immutable URLs: [terminal source](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/terminal.ts#L503), [renderer source](https://github.com/coder/ghostty-web/blob/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab/lib/renderer.ts#L128).

WezTerm main resolved to **2b56c4688f05823bde528d6b7f95b9094921337a**, committed 2026-09-11. [Pinned mux codec](https://github.com/wezterm/wezterm/blob/2b56c4688f05823bde528d6b7f95b9094921337a/codec/src/lib.rs#L834).

Revalidation: recheck upstream versions and contracts before implementation. Replace this note with version-pinned dependencies and benchmark results when the terminal migration lands.
