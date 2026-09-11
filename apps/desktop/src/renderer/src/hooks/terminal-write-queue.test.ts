import { describe, expect, it } from 'vitest'
import { createTerminalWriteQueue } from './terminal-write-queue'
describe('terminal render queue', () => {
  it('coalesces bursts and waits for xterm parsing before the next write', () => {
    const frames: (() => void)[] = []; const writes: string[] = []; const parsed: (() => void)[] = []
    const queue = createTerminalWriteQueue((text, done) => { writes.push(text); parsed.push(done) }, cb => { frames.push(cb); return frames.length }, () => {})
    queue.write('hello'); queue.write(' world'); frames.shift()!()
    queue.write(' next')
    expect(writes).toEqual(['hello world']); expect(frames).toHaveLength(0)
    parsed.shift()!(); frames.shift()!()
    expect(writes).toEqual(['hello world', ' next'])
  })
  it('drops scheduled writes on disposal', () => {
    const frames: (() => void)[] = []; const writes: string[] = []
    const queue = createTerminalWriteQueue(text => writes.push(text), cb => { frames.push(cb); return 1 }, () => {})
    queue.write('late'); queue.dispose(); frames[0]()
    expect(writes).toEqual([])
  })
})
