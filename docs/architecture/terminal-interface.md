# Terminal-only agent interface

Desktop and mobile display the same persistent PTY. Agents run their CLI, which
owns prompts, approvals, model selection, images, and conversation history. The
structured chat views and native SDK launch interception have been removed.
Archived native session records stay on disk and migrate to the corresponding
provider's CLI resume command. Migration never kills an existing terminal.

The reference is [Orca 1.4.197, commit 9aa0f7e](https://github.com/stablyai/orca/tree/9aa0f7e77d366c23a3cc8de2da32ae550d397dc0),
inspected September 11, 2026. In particular:

- `mobile/src/terminal/terminal-webview-html/smooth-scroll-and-cell-geometry.ts`
  batches touch pixels into whole xterm rows once per animation frame.
- `surface-touch-gestures.ts` adds interruptible momentum to local history.
- `write-queue.ts` orders output using xterm's asynchronous write callbacks.

Orchestra uses these architectural patterns with stable xterm 6 and its matching
WebGL/fit addons, retaining its existing daemon and authenticated Convex WebSocket
transport. It does not replace the deployment with Orca's React Native application
or custom relay service.

## Rendering and input

- WebGL paints terminal glyphs, with a DOM fallback if the GPU context is lost.
- A single-finger drag scrolls local history without a network round trip. Momentum
  uses elapsed time, stops at history bounds, and cancels on a new touch.
- Full-screen alternate buffers receive bounded, coalesced terminal scroll input.
  The first notch sends immediately and following notches coalesce within 32 ms.
  Their response time still depends on the connection and remote application.
- The desktop applies input in order independently of cloud acknowledgements.
  Acknowledgements have bounded concurrency and retain deduplication guards, so
  delayed deletes cannot replay keys or stall the next key. Output after an idle
  interval flushes immediately; continuing output coalesces within 16 ms.
- Ordered output queues prevent live bytes overtaking a replacement snapshot.
  Mobile snapshots preserve distance from the live bottom while reading history.
  An explicit Latest button returns to the prompt.
- Desktop attachment waits for bounded font/layout readiness and coalesces
  concurrent activation requests. A restored screen parses at its original grid;
  resizing waits for the queued parser callbacks, preventing displaced startup
  prompts that previously needed a manual window resize to repaint.
- Phone-owned geometry is enforced before desktop IPC can resize the shared PTY.
  Visual viewport changes keep input above the software keyboard.
- The keyboard button focuses the terminal's real input; image attachment stages
  files through the existing upload path; hold-to-talk uses the existing audio
  pipeline. Neither image attachment nor dictation automatically presses Enter.
- Holding Backspace starts character repeat after 350 ms, then repeats every
  50 ms. Release, cancellation, leaving the button, and losing focus stop it;
  holding never escalates into deleting whole lines.

## Long sessions and daemon lifetime

The daemon's disk history is capped at 5 MiB per terminal, independently of the
agent's own conversation transcript. Rotation must read through a readable file
descriptor. A regression opened history write-only and swallowed the read error
during rotation: beyond the cap, every output chunk allocated another 2.5 MiB
tail buffer and the file kept growing. Full-screen scrolling produces output
through this same persistence path. Real-filesystem tests cover the limit and
allocation churn; terminal session length alone must not grow this work forever.

The launcher preserves a reachable daemon across bundled code or runtime changes.
An unreachable socket with a live or unverified daemon PID fails without killing
the process or replacing its socket. Concurrent startup attempts share one promise.
Daemon updates are deferred until the existing daemon exits; updating the desktop
does not hot-patch a running daemon. Activating a daemon fix therefore needs a
controlled restart when its terminal work can safely stop.

## Verification

Run `bun run typecheck`, `bun run lint`, `bun run build`,
`cd apps/web && bun run test`, and `cd apps/desktop && bunx vitest run`.

The terminal browser check used Aside with the real TerminalPane, xterm, WebGL,
key bar, and image controls against an isolated transport fixture. At a 390×844
viewport it exercised touch scrolling and momentum, streaming while reading,
snapshot replacement, Latest, keyboard input, alternate-screen wheel reports,
and 44px input controls without horizontal overflow. It did not use production
agent sessions. Hardware iOS/Android behavior and live microphone transcription
still require device testing; browser emulation does not establish those results.
