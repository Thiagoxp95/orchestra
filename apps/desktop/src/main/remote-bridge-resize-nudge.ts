/**
 * Resize a session's PTY so its TUI does a full, clean reflow at the viewer's
 * geometry — even when the PTY is already at (cols, rows).
 *
 * When the web focuses a session, attach() resizes the daemon PTY to the phone's
 * size before snapshotting. But a plain resize to the size the PTY is *already*
 * at — resuming a desktop session whose width coincides, or re-focusing the same
 * session — is a no-op: no SIGWINCH reaches the TUI, so it never repaints and
 * stays wrapped at its old (desktop) width. Seeding that frame into the narrower
 * phone terminal renders garbled: lines wrap early on the left while the tail of
 * each wide line is pinned to the far-right column.
 *
 * Force a guaranteed change first by resizing to an off-by-one height, pausing so
 * the intermediate SIGWINCH actually reaches the program, then resizing to the
 * real target. The TUI gets a real resize event and re-wraps at the correct cols.
 * The brief intermediate frame is harmless: attach() snapshots only once the
 * screen settles at the final size.
 */
export async function reflowResize(
  resize: (cols: number, rows: number) => Promise<void>,
  cols: number,
  rows: number,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  nudgeMs = 60,
): Promise<void> {
  const nudgeRows = rows > 1 ? rows - 1 : rows + 1
  await resize(cols, nudgeRows)
  await delay(nudgeMs)
  await resize(cols, rows)
}
