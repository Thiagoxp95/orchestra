import type { SessionSnapshot } from '../daemon/protocol'

/**
 * Snapshot a session after a resize, waiting for the TUI's repaint to settle.
 *
 * Resizing a full-screen TUI (alt-screen) to a new width reflows the mirrored
 * buffer into garbage; the program repaints asynchronously on SIGWINCH, so a
 * snapshot taken immediately after the resize captures a half-reflowed frame.
 * Seeding that to a freshly attached viewer leaves ghosted/doubled text until
 * the live redraw paints over it. Poll the mirror until the serialized screen
 * stops changing (two identical reads, after the redraw has had time to land),
 * bounded by minSettleMs/timeoutMs. `now`/`delay` are injectable for testing.
 */
export async function snapshotWhenSettled(
  getSnapshot: () => Promise<SessionSnapshot | null>,
  {
    minSettleMs,
    intervalMs,
    timeoutMs,
    now = Date.now,
    delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    minSettleMs: number
    intervalMs: number
    timeoutMs: number
    now?: () => number
    delay?: (ms: number) => Promise<void>
  },
): Promise<SessionSnapshot | null> {
  const start = now()
  let prev: string | null = null
  let last: SessionSnapshot | null = null
  for (;;) {
    last = await getSnapshot()
    const sig = last?.snapshotAnsi ?? ''
    const elapsed = now() - start
    // Accept only once the screen has held steady past the redraw window, so an
    // early "stable" garbage frame (redraw not started yet) isn't mistaken for
    // the settled screen.
    if (sig === prev && elapsed >= minSettleMs) return last
    if (elapsed >= timeoutMs) return last
    prev = sig
    await delay(intervalMs)
  }
}
