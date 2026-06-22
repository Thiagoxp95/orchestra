import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { CLAUDE_TRUST_TRANSITION_B64, DIALOG_TO_ALT_BOUNDARY } from './__fixtures__/claude-trust-transition'

// Regression coverage for the web-attach "doubled / stacked screen" bug.
//
// Empirical root cause (verified against real claude 2.1.186 bytes): claude
// boots in an untrusted dir, draws a trust dialog on the MAIN screen, then on
// accept enters the ALTERNATE screen (ESC[?1049h ESC[2J ESC[H) and paints the
// banner + input box with a relative `ESC[H` + `\r ESC[1B` row walk that carries
// NO per-frame clear. The only thing that protects a freshly-seeded viewer from
// that relative walk landing at the wrong row is that the seed faithfully
// reproduces the mirror's buffer AND the live stream is replayed at a complete
// escape-sequence boundary. The daemon's SerializeAddon snapshot serializes the
// committed buffer (never a half-parsed escape), and the chunk transport
// (OutputBatcher + chunk-buffer + term.write) preserves every byte in order and
// lets xterm buffer partial sequences across writes — so the transition replays
// cleanly. These tests lock that invariant in: seed + resume == whole-stream,
// for BOTH the web seed path (snapshotAnsi + rehydrate, no reset) and the
// desktop seed path (reset + rehydrate + snapshotAnsi).

const FULL = Buffer.from(CLAUDE_TRUST_TRANSITION_B64, 'base64').toString('latin1')

// Mouse-ENABLE DECSETs the web bridge strips from the rehydrate seed.
const MOUSE_ENABLE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015)h/g

// Mirror the daemon's alternate-screen tracking (headless-emulator.ts only the
// alt mode matters for the seed's rehydrate here).
function altState(bytes: string): boolean {
  let alt = false
  const re = /\x1b\[\?(1049|47)([hl])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bytes)) !== null) alt = m[2] === 'h'
  return alt
}

function newTerm(cols = 80, rows = 30): Terminal {
  return new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
}
function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()))
}

type Snapshot = { snapshotAnsi: string; rehydrateSequences: string }

// Daemon getSnapshot equivalent: serialize the committed buffer + alt rehydrate.
// Mirrors headless-emulator.getSnapshotAsync — the write MUST be flushed before
// serialize, otherwise @xterm's batched parser hasn't committed the buffer yet.
async function snapshotAt(prefix: string): Promise<Snapshot> {
  const term = newTerm()
  const ser = new SerializeAddon()
  term.loadAddon(ser)
  await write(term, prefix)
  const snapshotAnsi = ser.serialize({ scrollback: 2000 })
  const rehydrateSequences = altState(prefix) ? '\x1b[?1049h' : ''
  return { snapshotAnsi, rehydrateSequences }
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

// Count nonblank lines that appear in `rows` but not in `ref` (leftover/ghost
// fragments — the user-visible "doubling" signature).
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

// Web seed: snapshotAnsi + rehydrate (mouse-enables stripped), no reset.
function webSeed(snap: { snapshotAnsi: string; rehydrateSequences: string }): string {
  return snap.snapshotAnsi + snap.rehydrateSequences.replace(MOUSE_ENABLE_RE, '')
}

async function seedWeb(term: Terminal, snap: Snapshot): Promise<void> {
  await write(term, webSeed(snap))
}
async function seedDesktop(term: Terminal, snap: Snapshot): Promise<void> {
  term.reset()
  if (snap.rehydrateSequences) await write(term, snap.rehydrateSequences)
  if (snap.snapshotAnsi) await write(term, snap.snapshotAnsi)
}

// Whole-stream ground truth: a viewer that joined before boot and saw every byte.
async function groundTruth(): Promise<Terminal> {
  const term = newTerm()
  await write(term, FULL)
  return term
}

// Find complete-escape-sequence boundaries inside the alt-screen paint region.
// The daemon never snapshots mid-sequence, so every legitimate attach boundary
// is one of these. We sample several across the banner/input-box paint.
function safeBoundaries(): number[] {
  const re = /\x1b\[[0-9;?]*[A-Za-z]/g
  const ends: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(FULL)) !== null) {
    const end = m.index + m[0].length
    if (end > DIALOG_TO_ALT_BOUNDARY && end < DIALOG_TO_ALT_BOUNDARY + 1700) ends.push(end)
  }
  const picked: number[] = []
  const step = Math.max(1, Math.floor(ends.length / 6))
  for (let i = 0; i < ends.length; i += step) picked.push(ends[i])
  return picked.slice(0, 6)
}

describe('claude trust→alt transition fixture', () => {
  it('contains the main→alt boundary and a no-clear relative repaint', () => {
    expect(FULL.indexOf('\x1b[?1049h')).toBe(DIALOG_TO_ALT_BOUNDARY)
    // exactly one full clear+home (the alt entry); the banner that follows is a
    // relative ESC[H + CR ESC[1B walk with no further ESC[2J.
    expect((FULL.match(/\x1b\[2J/g) ?? []).length).toBe(1)
    // a held trust dialog on the MAIN screen precedes the alt entry.
    expect(FULL.slice(0, DIALOG_TO_ALT_BOUNDARY)).toContain('trust this folder')
  })
})

describe('snapshot fidelity (daemon getSnapshot)', () => {
  it('seed-rendered buffer equals the mirror buffer at the main→alt boundary', async () => {
    const prefix = FULL.slice(0, DIALOG_TO_ALT_BOUNDARY)
    const mirror = newTerm()
    await write(mirror, prefix)
    const snap = await snapshotAt(prefix)
    const client = newTerm()
    await seedWeb(client, snap)
    expect(norm(visibleRows(client))).toBe(norm(visibleRows(mirror)))
    expect(client.buffer.active.type).toBe(mirror.buffer.active.type)
  })
})

describe('seed + resume replays the trust→alt transition without doubling', () => {
  it('WEB seed path matches the whole-stream ground truth across the transition', async () => {
    const gt = await groundTruth()
    // Snapshot while the trust dialog is held on the MAIN screen, then resume the
    // remainder (which carries ESC[?1049h ESC[2J ESC[H + the alt repaint).
    const prefix = FULL.slice(0, DIALOG_TO_ALT_BOUNDARY)
    const snap = await snapshotAt(prefix)
    const client = newTerm()
    await seedWeb(client, snap)
    await write(client, FULL.slice(DIALOG_TO_ALT_BOUNDARY))

    expect(client.buffer.active.type).toBe(gt.buffer.active.type)
    expect(norm(visibleRows(client))).toBe(norm(visibleRows(gt)))
    // No leftover dialog/banner fragments anywhere (incl. scrollback).
    expect(ghostLines(fullRows(gt), fullRows(client))).toEqual([])
  })

  it('DESKTOP seed path matches the whole-stream ground truth across the transition', async () => {
    const gt = await groundTruth()
    const prefix = FULL.slice(0, DIALOG_TO_ALT_BOUNDARY)
    const snap = await snapshotAt(prefix)
    const client = newTerm()
    await seedDesktop(client, snap)
    await write(client, FULL.slice(DIALOG_TO_ALT_BOUNDARY))

    expect(client.buffer.active.type).toBe(gt.buffer.active.type)
    expect(norm(visibleRows(client))).toBe(norm(visibleRows(gt)))
    expect(ghostLines(fullRows(gt), fullRows(client))).toEqual([])
  })

  it('stays clean for snapshots taken mid alt-screen repaint at any complete-sequence boundary', async () => {
    const gt = await groundTruth()
    const gtVis = norm(visibleRows(gt))
    for (const cut of safeBoundaries()) {
      const snap = await snapshotAt(FULL.slice(0, cut))
      // web path
      const web = newTerm()
      await seedWeb(web, snap)
      await write(web, FULL.slice(cut))
      expect(norm(visibleRows(web)), `web cut=${cut}`).toBe(gtVis)
      expect(ghostLines(fullRows(gt), fullRows(web)), `web ghosts cut=${cut}`).toEqual([])
      // desktop path
      const desk = newTerm()
      await seedDesktop(desk, snap)
      await write(desk, FULL.slice(cut))
      expect(norm(visibleRows(desk)), `desktop cut=${cut}`).toBe(gtVis)
      expect(ghostLines(fullRows(gt), fullRows(desk)), `desktop ghosts cut=${cut}`).toEqual([])
    }
  })

  it('steady-state alt snapshot seeds without doubling (web path, no reset)', async () => {
    const gt = await groundTruth()
    const snap = await snapshotAt(FULL) // whole stream → steady-state alt UI
    const client = newTerm()
    await seedWeb(client, snap)
    expect(client.buffer.active.type).toBe('alternate')
    expect(norm(visibleRows(client))).toBe(norm(visibleRows(gt)))
    expect(ghostLines(fullRows(gt), fullRows(client))).toEqual([])
  })
})
