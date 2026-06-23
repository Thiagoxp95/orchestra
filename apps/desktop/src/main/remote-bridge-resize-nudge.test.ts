import { describe, expect, it } from 'vitest'
import { reflowResize } from './remote-bridge-resize-nudge'

// Record the (cols, rows) of every resize so we can assert the nudge sequence.
function recorder() {
  const calls: Array<[number, number]> = []
  return {
    calls,
    resize: async (cols: number, rows: number) => {
      calls.push([cols, rows])
    },
    delay: async () => {},
  }
}

describe('reflowResize', () => {
  it('nudges the height down then back to force a SIGWINCH at the target size', async () => {
    const r = recorder()
    await reflowResize(r.resize, 40, 24, r.delay)
    expect(r.calls).toEqual([
      [40, 23], // off-by-one nudge — guarantees a real geometry change
      [40, 24], // settle at the viewer's true size
    ])
  })

  it('keeps cols constant so the reflow re-wraps at the viewer width', async () => {
    const r = recorder()
    await reflowResize(r.resize, 40, 24, r.delay)
    expect(r.calls.every(([cols]) => cols === 40)).toBe(true)
  })

  it('nudges up when the target height is 1 (cannot go lower)', async () => {
    const r = recorder()
    await reflowResize(r.resize, 80, 1, r.delay)
    expect(r.calls).toEqual([
      [80, 2],
      [80, 1],
    ])
  })

  it('pauses between resizes so the intermediate SIGWINCH reaches the program', async () => {
    const r = recorder()
    let waited = 0
    await reflowResize(r.resize, 40, 24, async (ms) => {
      waited += ms
    })
    expect(waited).toBeGreaterThan(0)
  })
})
