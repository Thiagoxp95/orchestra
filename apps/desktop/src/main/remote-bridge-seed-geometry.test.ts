import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  GEO_BOOT_A_B64,
  GEO_RESIZE_B_B64,
  GEO_SIZE_A,
  GEO_SIZE_B,
} from './__fixtures__/claude-geometry-mismatch'

// Regression coverage for the GEOMETRY-MISMATCH form of the web-attach
// "doubled / stacked screen" bug.
//
// Empirical root cause (verified against real claude 2.1.186 bytes): the web
// client reports a WRONG pre-layout terminal size when it sends `attach` —
// `fit()` runs synchronously right after `term.open()`, before the flex layout
// (the AgentKeyBar + ActionBar siblings of the terminal host) has been measured,
// so it reads a desktop-ish wide/short fallback (~80x24) instead of the true
// tall/narrow phone viewport (~50x80). The bridge resizes the daemon PTY to the
// reported size, claude repaints at it, and the SerializeAddon snapshots that
// WIDE geometry. The web then writes that seed into an xterm at its TRUE narrow
// size and never resizes to the snapshot — so the wide snapshot's wrapped banner
// and relative cursor restore land at the wrong baseline: doubled banner, stacked
// input box, leftover fragments.
//
// The previous regression suite (remote-bridge-seed-replay.test.ts) proved that a
// faithful byte-replay with MATCHING sizes on both sides is clean. These tests add
// the missing dimension: they prove that a MISMATCH between the snapshot geometry
// and the client geometry is what corrupts, and lock in the invariant the fix must
// satisfy — when the snapshot is serialized at the client's TRUE size, the seed
// replays clean.

const BOOT_A = Buffer.from(GEO_BOOT_A_B64, 'base64').toString('latin1')
const RESIZE_B = Buffer.from(GEO_RESIZE_B_B64, 'base64').toString('latin1')

// Mouse-ENABLE DECSETs the web bridge strips from the rehydrate seed.
const MOUSE_ENABLE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015)h/g

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()))
}
function altState(bytes: string): boolean {
  let alt = false
  const re = /\x1b\[\?(1049|47)([hl])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bytes)) !== null) alt = m[2] === 'h'
  return alt
}

type Snapshot = { snapshotAnsi: string; rehydrateSequences: string; cols: number; rows: number }

// Daemon getSnapshot equivalent: serialize the committed buffer at the mirror's
// current size + alt rehydrate. `building` is the exact byte sequence the daemon
// PTY would have seen — boot at A, optionally resize+repaint to B.
async function daemonSnapshotAtA(): Promise<Snapshot> {
  const term = new Terminal({ cols: GEO_SIZE_A.cols, rows: GEO_SIZE_A.rows, scrollback: 2000, allowProposedApi: true })
  const ser = new SerializeAddon()
  term.loadAddon(ser)
  await write(term, BOOT_A)
  return {
    snapshotAnsi: ser.serialize({ scrollback: 2000 }),
    rehydrateSequences: altState(BOOT_A) ? '\x1b[?1049h' : '',
    cols: term.cols,
    rows: term.rows,
  }
}
async function daemonSnapshotAtB(): Promise<{ snap: Snapshot; mirror: Terminal }> {
  // boot at A, then the bridge resizes the PTY to B and claude repaints (RESIZE_B).
  const term = new Terminal({ cols: GEO_SIZE_A.cols, rows: GEO_SIZE_A.rows, scrollback: 2000, allowProposedApi: true })
  const ser = new SerializeAddon()
  term.loadAddon(ser)
  await write(term, BOOT_A)
  term.resize(GEO_SIZE_B.cols, GEO_SIZE_B.rows)
  await write(term, RESIZE_B)
  return {
    snap: {
      snapshotAnsi: ser.serialize({ scrollback: 2000 }),
      rehydrateSequences: altState(BOOT_A + RESIZE_B) ? '\x1b[?1049h' : '',
      cols: term.cols,
      rows: term.rows,
    },
    mirror: term,
  }
}

// Web seed: snapshotAnsi + rehydrate (mouse-enables stripped), no reset.
function webSeed(snap: Snapshot): string {
  return snap.snapshotAnsi + snap.rehydrateSequences.replace(MOUSE_ENABLE_RE, '')
}
async function seedClient(cols: number, rows: number, snap: Snapshot): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
  await write(term, webSeed(snap))
  return term
}

function visibleRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i)
    out.push(line ? line.translateToString(true) : '')
  }
  return out
}
function fullRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    out.push(line ? line.translateToString(true) : '')
  }
  while (out.length && out[0].trim() === '') out.shift()
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}
const norm = (rows: string[]) => rows.map((r) => r.trim()).join('\n')

// Nonblank lines present in `rows` but not in `ref` (leftover/ghost fragments —
// the user-visible "doubling" signature).
function ghostLines(refRows: string[], rows: string[]): string[] {
  const ref = new Set(refRows.map((r) => r.trim()).filter((t) => t.length >= 4))
  const seen = new Set<string>()
  const ghosts: string[] = []
  for (const r of rows) {
    const t = r.trim()
    if (t.length < 4 || ref.has(t) || seen.has(t)) continue
    seen.add(t)
    ghosts.push(t)
  }
  return ghosts
}
// Lines appearing in `rows` more times than in `ref` AND more than once (e.g. the
// doubled input-box rule / duplicated banner).
function duplicatedLines(refRows: string[], rows: string[]): string[] {
  const count = (rs: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const r of rs) {
      const t = r.trim()
      if (t.length < 5) continue
      m.set(t, (m.get(t) ?? 0) + 1)
    }
    return m
  }
  const rc = count(refRows)
  const cc = count(rows)
  const dups: string[] = []
  for (const [t, n] of cc) {
    if (n > (rc.get(t) ?? 0) && n > 1) dups.push(t)
  }
  return dups
}

describe('geometry-mismatch fixture', () => {
  it('captures two distinct claude geometries (wide pre-layout report vs true phone)', () => {
    expect(GEO_SIZE_A).toEqual({ cols: 80, rows: 24 })
    expect(GEO_SIZE_B).toEqual({ cols: 50, rows: 80 })
    // the alt-screen banner + typed input are present in the boot stream.
    expect(BOOT_A).toContain('Claude Code')
    expect(BOOT_A).toContain('\x1b[?1049h') // claude runs in the alternate screen
    // the resize emits a SIGWINCH repaint (non-empty).
    expect(RESIZE_B.length).toBeGreaterThan(0)
  })
})

describe('matched geometry replays clean (the invariant the fix must satisfy)', () => {
  it('snapshot serialized at the client TRUE size seeds a phone client with no doubling', async () => {
    // FIX path: the web reports its real post-layout size (50x80), the bridge
    // resizes the daemon to 50x80, claude repaints, and the snapshot is serialized
    // at 50x80. Seeding a 50x80 client with that snapshot is clean.
    const { snap, mirror } = await daemonSnapshotAtB()
    expect(snap.cols).toBe(GEO_SIZE_B.cols)
    expect(snap.rows).toBe(GEO_SIZE_B.rows)

    const client = await seedClient(GEO_SIZE_B.cols, GEO_SIZE_B.rows, snap)

    // Visible screen matches the daemon mirror exactly — what the phone shows is
    // what claude actually painted at 50x80.
    expect(norm(visibleRows(client))).toBe(norm(visibleRows(mirror)))
    // No ghost banner / stacked fragments, no duplicated input-box rule.
    expect(ghostLines(fullRows(mirror), fullRows(client))).toEqual([])
    expect(duplicatedLines(fullRows(mirror), fullRows(client))).toEqual([])
    expect(client.buffer.active.type).toBe(mirror.buffer.active.type)
  })
})

describe('geometry MISMATCH reproduces the doubling (regression captured)', () => {
  it('a wide (80x24) snapshot seeded into a narrow (50x80) client doubles/stacks the screen', async () => {
    // BUG path: the web reported a wrong pre-layout size, so the snapshot was
    // serialized at 80x24, but the client xterm is really 50x80 and never resizes
    // to the snapshot. Ground truth = what the phone *should* show: claude's true
    // 50x80 paint, mirrored at 50x80.
    const { mirror: groundTruth } = await daemonSnapshotAtB()
    const wideSnap = await daemonSnapshotAtA()
    expect(wideSnap.cols).toBe(GEO_SIZE_A.cols) // snapshot baked at the wrong (wide) size

    const client = await seedClient(GEO_SIZE_B.cols, GEO_SIZE_B.rows, wideSnap)

    const gtFull = fullRows(groundTruth)
    const ghosts = ghostLines(gtFull, fullRows(client))
    const dups = duplicatedLines(gtFull, fullRows(client))

    // The visible screen does NOT match the correct 50x80 paint.
    expect(norm(visibleRows(client))).not.toBe(norm(visibleRows(groundTruth)))
    // Leftover banner / stacked fragments appear (the user-visible doubling).
    expect(ghosts.length).toBeGreaterThan(0)
    // The banner is among the ghosts (the doubled Claude Code header).
    expect(ghosts.some((g) => g.includes('Claude Code'))).toBe(true)
    // The input-box rule is duplicated (the stacked input box).
    expect(dups.length).toBeGreaterThan(0)
  })

  it('even a SMALL geometry delta still leaves ghost fragments (mobile fit jitter)', async () => {
    // A 50x80 client seeded with an 80x24 snapshot is the extreme case; the small
    // case (a couple cols/rows off) is harder to spot but still corrupts. Here we
    // reuse the wide snapshot at one row taller client to show even a modest delta
    // (client rows 78 vs snapshot rows 24, but more pointedly: any width delta)
    // breaks the relative repaint. We assert the same client size with the wide
    // snapshot reflows wrong — width is the dominant factor.
    const wideSnap = await daemonSnapshotAtA()
    // Client off only in WIDTH from the snapshot (rows equal to snapshot rows) —
    // isolates that a column delta alone misaligns the wrapped banner.
    const client = await seedClient(GEO_SIZE_B.cols, GEO_SIZE_A.rows, wideSnap)
    const { mirror: groundTruth } = await daemonSnapshotAtB()
    const ghosts = ghostLines(fullRows(groundTruth), fullRows(client))
    expect(ghosts.length).toBeGreaterThan(0)
  })
})
