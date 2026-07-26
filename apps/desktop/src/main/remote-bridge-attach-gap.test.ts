import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

// Regression coverage for the ATTACH-GAP form of the web mirror's "stale row
// that nothing erases" bug (duplicated spinner line, caret drawn outside the
// input box, characters shuffled mid-line).
//
// Root cause: attach() set `attachedSessionId` up front but only created the
// output batcher at the very end, after the seed snapshot had made a round trip
// to Convex. The daemon data tap dropped everything in between (`!batcher →
// return`). Those bytes are on the far side of the snapshot, so they are in
// neither the seed nor anything that follows it — and a TUI repaints
// differentially, so it never re-sends a frame it believes it already drew.
//
// The invariant these tests lock in: seed + EVERY post-snapshot byte
// reconstructs the daemon's screen exactly, because that is how the daemon
// builds its own. Swallow any window of those bytes and the mirror desyncs for
// good — later frames' relative cursor walks land on the wrong row, so old rows
// survive underneath the new ones.

const COLS = 50
const ROWS = 20

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()))
}

function newTerm(): { term: Terminal; ser: SerializeAddon } {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
  const ser = new SerializeAddon()
  term.loadAddon(ser)
  return { term, ser }
}

function visibleRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i)
    out.push(line ? line.translateToString(true).trimEnd() : '')
  }
  return out
}
const screen = (term: Terminal) => visibleRows(term).join('\n')
const formingRows = (term: Terminal) => visibleRows(term).filter((r) => r.includes('Forming'))

// How an Ink app (claude code) repaints: walk the cursor back up over the block
// it drew last time, then erase-and-rewrite each line. Nothing in a frame states
// where the block *is* — every frame is relative to where the previous one left
// the cursor, which is exactly why a swallowed byte window is unrecoverable.
function inkFrame(prevHeight: number, lines: string[]): string {
  const up = prevHeight > 0 ? `\x1b[${prevHeight}A` : ''
  return up + '\r' + lines.map((l) => `\x1b[2K${l}`).join('\r\n') + '\r\n'
}

const TRANSCRIPT =
  'I’ll dig into the mobile sidebar/drawer code.\r\n' +
  '\r\n' +
  'Reading 1 file, calling codegraph 2 times, running\r\n' +
  '2 shell commands…\r\n'

// The block claude keeps repainting in place, one frame per spinner tick.
const FRAMES: string[][] = [
  ['✳ Forming… (24s · thinking with xhigh effort)'],
  ['Reading ui/sidebar.tsx', '✢ Forming… (26s)'],
  ['Reading ui/sidebar.tsx', '✳ Forming… (28s)'],
  ['Reading ui/sidebar.tsx', '✢ Forming… (30s · 1.3k tokens)'],
]

/** Bytes the PTY emits after the seed snapshot was taken (frames 1..n). */
function postSnapshotBytes(): string {
  let out = ''
  for (let i = 1; i < FRAMES.length; i++) out += inkFrame(FRAMES[i - 1].length, FRAMES[i])
  return out
}

/** The daemon's own screen: everything, in order, nothing skipped. */
async function daemonScreen(): Promise<Terminal> {
  const { term } = newTerm()
  await write(term, TRANSCRIPT + inkFrame(0, FRAMES[0]) + postSnapshotBytes())
  return term
}

/** The seed the bridge sends: the daemon serialized right after frame 0. */
async function seedAfterFrame0(): Promise<string> {
  const { term, ser } = newTerm()
  await write(term, TRANSCRIPT + inkFrame(0, FRAMES[0]))
  return ser.serialize({ scrollback: 2000 })
}

/** A web client: reset, apply the seed, then replay whatever bytes reached it. */
async function client(seed: string, stream: string): Promise<Terminal> {
  const { term } = newTerm()
  await write(term, seed)
  await write(term, stream)
  return term
}

describe('attach gap', () => {
  it('replaying every post-snapshot byte reproduces the daemon screen exactly', async () => {
    const daemon = await daemonScreen()
    const mirror = await client(await seedAfterFrame0(), postSnapshotBytes())

    expect(screen(mirror)).toBe(screen(daemon))
    // One spinner line, the current one — nothing stale left behind.
    expect(formingRows(mirror)).toEqual(formingRows(daemon))
    expect(formingRows(mirror)).toHaveLength(1)
    expect(formingRows(mirror)[0]).toContain('30s')
  })

  it('swallowing the bytes right after the snapshot strands a stale spinner row', async () => {
    // What the old tap did: the gap opens the instant the snapshot is taken and
    // stays open while the seed makes its round trip to Convex, so the swallowed
    // window is the HEAD of the post-snapshot stream — here, the cursor walk of
    // the frame that grew the block by a row.
    const post = postSnapshotBytes()
    const swallowed = post.slice(24)

    const daemon = await daemonScreen()
    const mirror = await client(await seedAfterFrame0(), swallowed)

    // The mirror is not showing what the PTY shows, and never will: the frames
    // that follow only ever repaint relative to where this one left the cursor.
    expect(screen(mirror)).not.toBe(screen(daemon))
    // The user-visible signature: two "Forming…" rows, the older one frozen.
    const stale = formingRows(mirror)
    expect(stale.length).toBeGreaterThan(1)
    expect(stale.some((r) => r.includes('24s'))).toBe(true)
    expect(stale.some((r) => r.includes('30s'))).toBe(true)
  })
})
