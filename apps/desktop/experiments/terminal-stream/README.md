# Terminal stream prototype

A runnable single-session architecture experiment. It starts a real PTY running a deterministic fixture, records ordered binary output/resize events to a scratch archive, and serves two viewers using the same xterm client. There are no Convex terminal chunks or commands on this path.

The active web viewer **automatically reflows the shared PTY to its viewport**. Viewer A activates initially; focusing the other terminal or taking control there transfers the session lease. Passive viewers receive the resulting ordered resize. Viewport resizes are debounced and only the current visible controller may issue them.

## Run

Use the existing workspace dependencies and Node 22.18+ (verified with Node 25.9.0):

```sh
bun run terminal:lab
```

Open <http://127.0.0.1:4381>. The lab binds only to loopback. Generate 5,000 rows, scroll Viewer B back, start streaming, and reconnect B. Its history position should remain stable while A follows new output. Slow acknowledgements holds B's parser acknowledgements for 500 ms without limiting A.

Optional separate Electron shell using the identical page/client, with isolated temporary Electron user data:

```sh
bun run terminal:lab:electron
```

The Electron launcher was syntax-checked; native Electron behavior has not been verified. Browser QA uses Aside, not a native app driver.

Ctrl-C on the server kills the synthetic PTY, closes sockets, and removes that run's scratch archive. `ORCHESTRA_LAB_PORT` overrides port 4381 for the server and Electron launcher. No real Orchestra sessions, credentials, or history are accessed. Restart the server for a fresh repeatable browser run.

If workspace dependency links are incomplete, `bun install --ignore-scripts --frozen-lockfile` restores them without updating the lockfile. This machine's node-pty macOS ARM64 `spawn-helper` also needed its existing file's owner executable bit restored; that local dependency permission fix is not a source change.

## Verification

```sh
bun run terminal:lab:test
cd apps/desktop
bunx tsc -p experiments/terminal-stream/tsconfig.json
bunx oxlint -c ../../oxlintrc.json experiments/terminal-stream
```

From the repository root, with a fresh server running:

```sh
aside account use u1
aside repl "$(cat apps/desktop/experiments/terminal-stream/browser-qa.js)"
```

The Aside script opens and closes its own tab. Restore the prior account if it was different; this session was already using u1. It compares visible cell contents, colors, widths, cursor, and terminal modes at matching applied positions. It exercises long output, streaming while reading, reconnect, alternate/normal buffers, automatic viewport reflow, and an independently slow viewer. Screenshots go to Aside's session scratch directory.

Observed September 11, 2026:

- **12 tests passed** across the session/client and real-WebSocket integration suites.
- Type checking and linting passed with **0 warnings and 0 errors**.
- Repository-wide lint completed with 0 errors and 676 warnings outside the prototype; the focused prototype lint is clean.
- Browser: Viewer B preserved `row-001978` through streaming and reconnect after 5,000 generated rows; both viewers' visible cells, foreground/background colors, widths, cursor, and modes matched.
- Browser: narrowing the active viewport changed the shared grid from **87×23 to 53×23**, then restored it. Both viewers converged.
- Browser: alternate-screen enter/exit converged; a viewer with delayed acknowledgements lagged while the other continued and subsequently caught up.
- Browser: the active viewer automatically regained its control lease after reconnect. This check first failed, then passed after the reconnect activation logic was corrected. On the final run, `row-022538` remained the reader's anchor throughout output and recovery.
- A screenshot was visually inspected: both WebGL viewers rendered colored Unicode output, with B reading earlier content independently.
- Server shutdown was exercised: the synthetic PTY and listener exited and no prototype scratch archives remained. A new lab run was then started.

These are correctness checks on the local Aside browser, not comparative performance benchmarks or claims about production flicker, mobile Safari, native Electron, or network latency.

## What the slice establishes

`SessionLog` owns a random PTY incarnation, monotonically increasing uint64 event sequence and UTF-8 output offset. Output and actual resize requests share an event log. Index entries are published only after their complete record has been written. An attaching viewer reads a contiguous suffix while new output can continue appending; there is no separate snapshot/subscription handoff.

`createRelay` authenticates the local connection and origin, validates its incarnation and cursor, reads archive records on demand, and bounds unacknowledged output independently for each viewer. It rejects acknowledgements for unsent records. A per-session lease gates input and resize, and input IDs deduplicate within a connection. The client does not resend uncertain input after reconnect.

`TerminalApplier` accepts raw binary events, verifies continuity, writes them in order, and advances its cursor only after xterm's parser callback. It never resets the terminal during retained-offset reconnect. Split UTF-8 and escape sequences survive because the exact bytes and parser instance are retained.

`TerminalConnection` is shared by every viewer. It waits for already-queued parsing before reconnecting and sends the applied cursor. Parser credit uses a timer, independent of animation frames. The UI updates diagnostics on a bounded timer; terminal output never enters React state.

## Explicit limits and remaining work

This is the **Node baseline** for the architecture investigation, not the production migration or a Rust/Ghostty comparison.

- Host and relay modules currently run in one local process. Production still needs a separate outbound WSS host connection, relay deployment, device authorization, and the adapter to Orchestra's persistent daemon.
- First attach replays the exact log from its initial geometry. This is a correct replay checkpoint, **not** a fast serialized-state checkpoint. First attach cost grows with recorded output. A validated indexed checkpoint format remains necessary for fast attachment to large sessions.
- Scratch output is capped at **64 MiB and 20,000 events**. The archive is temporary, not crash-durable: no fsync, restart recovery, retention rotation, or production disk-full policy. On the archive cap or a write error, output capture stops explicitly.
- Server pending output is capped at **1 MiB**, with PTY pause/resume watermarks of 128/32 KiB. Frames carry at most **16 KiB** of payload. Each viewer has a **64 KiB** wire-byte window; client pending frames are capped at **128 KiB**. Pending input/resize work is capped at **64 commands**, and input payloads at **4 KiB**. The deterministic producer also respects stdout backpressure.
- Each renderer keeps **10,000 live scrollback rows**. Reading beyond that requires an archive history viewer, which is not implemented. Reading across retention/reflow needs stable archive anchors; this experiment verifies retained local-history anchors during output and reconnect.
- The fixture exercises Unicode, colors, normal/alternate buffers, interruption, and resize. Arbitrary agent terminal queries, synchronized updates, images, IME, mobile touch behavior, WebGL context recovery, and a complete emulator conformance corpus remain to be tested.
- No comparative FPS, memory plateau, WAN latency, native Electron, hardware iOS/Android, Rust relay, or Ghostty measurements are claimed.

The next slice should attach this protocol to one real daemon-owned session and implement validated indexed checkpoints. Keep the synthetic fixture and replay tests as the oracle for that integration.

## Production integration harness

`bun run terminal:production-lab` starts a separate synthetic PTY on http://127.0.0.1:4382/production.html. It imports the production daemon event ring/checkpoint emulator, desktop host, relay and web client, rather than the prototype transport. It neither connects to user sessions nor uses production credentials.

With Aside's work profile selected, run:

```sh
aside repl "$(cat apps/desktop/experiments/terminal-stream/production-browser-qa.js)"
aside repl "$(cat apps/desktop/experiments/terminal-stream/production-long-qa.js)"
```

The first script expects a fresh harness session and checks 5,000 rows, reconnect/reading position, formatting, alternate screens, automatic viewport resize and independent slow-viewer credit. The second continues beyond 100,000 generated rows and checks bounded live history, retained line identity under trimming, reconnect and a new checkpoint attachment. Both close their own browser tabs. Stop the harness with Ctrl-C to terminate its synthetic PTY.
