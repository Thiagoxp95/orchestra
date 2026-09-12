# Terminal stream production implementation plan

> **For agentic workers:** Use subagent-driven-development to implement and review each task.

**Goal:** Ship the validated terminal streaming architecture in Orchestra's real web and desktop applications.

**Architecture:** The daemon orders output and resize events. A dedicated outbound WebSocket relay routes authenticated viewers, with bounded credits and parser acknowledgements. Convex retains authentication and product metadata. Active web viewports automatically control the viewed session's geometry.

**Tech Stack:** TypeScript, xterm 6, Node ws, Convex, Fly.io, Next.js/Vercel, Electron.

**Spec:** docs/architecture/terminal-streaming-refactor.md and apps/desktop/experiments/terminal-stream/README.md.

## Global Constraints

- Preserve running PTYs and the existing product's input, touch, image and action controls.
- Automatically reflow to the active web viewport; ownership is per session.
- Output and resize share a uint64 sequence; output offset counts UTF-8 bytes. Shared frame codec: apps/desktop/src/shared/terminal-stream/protocol.ts, version 1, header 18 bytes, payload at most 16 KiB.
- Bound every network queue; acknowledge only parser completion; retain contiguous suffixes for reconnect.
- Capability fallback keeps older live daemons usable without killing their sessions.
- Source changes stay on feat/terminal-stream until validated. User explicitly authorizes publishing, release and deployment.

### Task 1: Daemon event stream and atomic checkpoints

**Files:** daemon/session.ts, daemon/headless-emulator.ts, daemon/protocol.ts, daemon/daemon.ts, new daemon/terminal-stream.ts and tests, main/daemon-client.ts (RPC wrappers only), shared/terminal-stream/protocol.ts (codec validation only).

**Interfaces:** DaemonClient exposes supportsTerminalStream(): boolean, getTerminalStreamCheckpoint(sessionId): Promise<StreamCheckpoint>, readTerminalStream(sessionId, epoch, afterSeq, maxBytes): Promise<StreamRead>. Export types in shared/terminal-stream/protocol.ts. StreamCheckpoint = {epoch:string,seq:string,offset:string,cols:number,rows:number,data:string}; StreamRead = {epoch:string,frames:string[],gap:boolean} (base64 complete binary frames). maxBytes is clamped to 64 KiB. Advertise terminalStreamVersion:1 in hello, captured by the client's existing handshake; old hello means unsupported. Existing resize/write RPCs remain available.

- [ ] Test output/resize ordering, bounded retention and gap detection, snapshot-plus-suffix parity including split CSI/OSC/UTF-8, and old daemon capability detection.
- [ ] Implement a per-session event ring bounded to 8 MiB, with lazy allocation and incarnation UUID. Append all visible output including synthetic clear. Split UTF-8 encoded output into <=16 KiB frames without changing bytes.
- [ ] Make emulator writes, resize and snapshot execute in one ordered queue. Serialize inside the reserved queue cut. Preserve parser continuation at split escape sequences, or reserve a safe earlier checkpoint plus its exact continuation; do not silently drop partial parser state. Increase authoritative scrollback to 10,000.
- [ ] Capture checkpoint cursor synchronously at reservation, return snapshot through that cut, then serve exact retained suffix. Reject cursor outside retention or wrong incarnation. Bound checkpoint response and reject unsupported state explicitly rather than returning corrupt state.
- [ ] Add RPC dispatch and typed client wrappers; run focused Vitest, desktop typecheck, then commit only owned files.

### Task 2: Authenticated relay and desktop host adapter

**Files:** new apps/terminal-relay workspace, infra/terminal-relay, backend convex terminalStream.ts, new main terminal-stream-host.ts and tests, remote-bridge.ts integration and session geometry hooks.

**Interfaces:** Viewer connects to /viewer; first JSON {type:'viewer',token,sessionId}. Host connects to /host; first JSON {type:'host',secret}. Relay assigns uint32 connection id. Relay sends host {type:'open',id,sessionId}, {type:'client',id,message}, {type:'close',id}. Host sends {type:'server',id,message} or binary uint32 big-endian id followed by a frame. Viewer controls: attach {epoch,seq,offset}, ack {seq,offset}, claim, resize {lease,id,cols,rows}, input {lease,id,data}. Server controls: seed checkpoint fields, ready {epoch}, lease {controller,lease}, error {message}, unavailable {message}. Endpoint defaults to wss://orchestra-terminal-relay.fly.dev, environment override allowed.

- [ ] Add authenticated origin-checked relay, bounded connection count/payload/queued bytes, auth timeout and keepalive. Authorize token/session through a read-only Convex query. Never log tokens, secrets or terminal payloads.
- [ ] Add desktop outbound reconnecting host, capability negotiation, seed acknowledgement before suffix, 64 KiB per-viewer credit, exact ack validation and independent readers.
- [ ] Implement one lease per session, stale input rejection and monotonic input ids, resize only that session, and desktop geometry coordination. Host restart revokes leases; uncertain keystrokes are not replayed.
- [ ] Test relay authentication/routing/backpressure and host checkpoint/reconnect/lease behavior. Commit, deploy relay and backend, verify health.

### Task 3: Production web client integration

**Files:** web Terminal.tsx, new web lib/terminal-stream modules and tests; parent session props only if needed.

**Interfaces:** Uses Task 2 viewer protocol and Task 1 frame codec. Adopt the validated TerminalApplier/TerminalConnection design, extended with checkpoints, authentication and availability fallback.

- [ ] Keep the production terminal controls, use xterm 6/WebGL and identical Nerd font metrics, and replace chunk subscription output for compatible stream sessions.
- [ ] Parse binary frames outside React, ack after write callback, reject gaps, reconnect from applied cursor and avoid reset on ordinary reconnect or resize.
- [ ] Seed at recorded geometry; stage replacement checkpoints and keep visible history until ready. Explicitly report expired retained history. Bound live scrollback to 10,000 and pending bytes to 128 KiB.
- [ ] Automatically claim on activation and debounce fit geometry at 120 ms; passive viewers cannot resize or send input. Retain legacy transport only for explicit unsupported-daemon response, never concurrently.
- [ ] Test parser ordering, checkpoint transitions, reconnect, lease changes and legacy fallback. Run typecheck and production build, commit.

### Task 4: Release validation and deployment

**Files:** architecture rollout docs, release metadata, packaging exclusion for experiments.

- [ ] Review complete branch, resolve correctness/security findings, run focused tests plus root lint/typecheck/build.
- [ ] Exercise production components against disposable PTY via Aside: long scrolling, two viewers, reconnect, alternate screen, active viewport reflow and auth denial. Never send synthetic commands into a user's real session.
- [ ] Deploy backend/relay/web with compatible ordering, merge and push main, cut minor desktop release using release script, monitor CI and signed release publication.
- [ ] Verify deployed service health and published versions. Document tested scope and any compatibility or platform limitations truthfully.
