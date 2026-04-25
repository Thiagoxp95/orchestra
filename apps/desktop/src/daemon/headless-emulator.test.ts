import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

describe('HeadlessEmulator.getSnapshotAsync', () => {
  it('reflects writes queued in the same synchronous tick as the snapshot', async () => {
    const emu = new HeadlessEmulator(80, 24, '/tmp')
    emu.write('HELLO_WORLD_TOKEN')
    const snapshot = await emu.getSnapshotAsync()
    expect(snapshot.snapshotAnsi).toContain('HELLO_WORLD_TOKEN')
    emu.dispose()
  })

  it('honours a clear sequence queued right before the snapshot', async () => {
    const emu = new HeadlessEmulator(80, 24, '/tmp')
    emu.write('WARM_SHELL_PROMPT_TOKEN\r\n')
    // Let the first write settle into xterm so the token is in its state.
    await emu.getSnapshotAsync()

    // Now simulate what Session.emitClearToAll does: write a clear sequence
    // and immediately request a snapshot in the same tick.
    emu.write('\x1b[H\x1b[2J\x1b[3J')
    const snapshot = await emu.getSnapshotAsync()
    expect(snapshot.snapshotAnsi).not.toContain('WARM_SHELL_PROMPT_TOKEN')
    emu.dispose()
  })

  it('picks up a write + snapshot pair scheduled on the next macrotask', async () => {
    // This mirrors the production warm-shell flow where emitClearToAll runs
    // synchronously inside one daemon message handler and getSnapshotAsync
    // runs inside the *next* handler (a different socket message).
    const emu = new HeadlessEmulator(80, 24, '/tmp')
    emu.write('WARM_SHELL_PROMPT_TOKEN\r\n')
    await emu.getSnapshotAsync()
    // Yield, then queue clear + snapshot on the next tick.
    await new Promise<void>((resolve) => setImmediate(resolve))
    emu.write('\x1b[H\x1b[2J\x1b[3J')
    const snapshot = await emu.getSnapshotAsync()
    expect(snapshot.snapshotAnsi).not.toContain('WARM_SHELL_PROMPT_TOKEN')
    emu.dispose()
  })
})
