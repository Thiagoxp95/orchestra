// Synthetic research probe: no live PTY, network, or user history access.
import { createRequire } from 'node:module'
import { HeadlessEmulator } from '../../apps/desktop/src/daemon/headless-emulator'
import { nextChunks } from '../../apps/web/src/lib/chunk-buffer'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { Terminal } = require('@xterm/headless')
const write = (term: any, data: string) => new Promise<void>(resolve => term.write(data, resolve))
const lineAt = (term: any, index: number) => term.buffer.active.getLine(index)?.translateToString(true)
const output = Array.from({ length: 5000 }, (_, i) => `row-${String(i).padStart(5, '0')}\r\n`).join('')
const local = new Terminal({ cols: 100, rows: 24, scrollback: 10000, allowProposedApi: true })
const restored = new Terminal({ cols: 100, rows: 24, scrollback: 10000, allowProposedApi: true })
const daemon = new HeadlessEmulator(100, 24, '/tmp')
await write(local, output)
daemon.write(output)
const snapshot = await daemon.getSnapshotAsync()
await write(restored, snapshot.snapshotAnsi + snapshot.rehydrateSequences)
const oldAnchor = 1000
const distanceFromBottom = local.buffer.active.baseY - oldAnchor
const replacementAnchor = Math.max(0, restored.buffer.active.baseY - distanceFromBottom)
console.log(JSON.stringify({ experiment: '5000 lines, replace from actual daemon snapshot', localLines: local.buffer.active.length, restoredLines: restored.buffer.active.length, localBaseY: local.buffer.active.baseY, restoredBaseY: restored.buffer.active.baseY, beforeAnchor: lineAt(local, oldAnchor), afterAnchor: lineAt(restored, replacementAnchor), seedBytes: Buffer.byteLength(snapshot.snapshotAnsi + snapshot.rehydrateSequences) }))
console.log(JSON.stringify({ experiment: 'sequence gap input 1, 3', actual: nextChunks([{ seq: 1, data: 'A' }, { seq: 3, data: 'C' }], 0) }))
local.dispose()
restored.dispose()
daemon.dispose()
