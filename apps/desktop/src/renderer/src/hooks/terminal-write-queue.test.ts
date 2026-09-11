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

it('keeps geometry changes behind completion of every queued xterm parse', async () => {
  const frames: Array<() => void> = []; const parsed: Array<() => void> = []
  const queue = createTerminalWriteQueue((_text, done) => { parsed.push(done) }, cb => { frames.push(cb); return frames.length }, () => {})
  queue.write('snapshot')
  let completed = false
  const flushed = queue.flush().then(() => { completed = true })
  frames.shift()!(); await Promise.resolve()
  expect(completed).toBe(false)
  parsed.shift()!(); await flushed
  expect(completed).toBe(true)
})
