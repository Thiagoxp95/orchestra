import { describe, expect, it } from 'vitest'
import { deliverAfterResume, type ResumeSendDeps } from './remote-bridge-resume-send'
import type { TuiPrompt } from './tui-prompt-detector'

// The trust gate as detectTuiPrompt returns it — option 1 is the unattended answer.
const TRUST: TuiPrompt = {
  kind: 'trust',
  title: 'Trust this folder?',
  options: [
    { label: 'Yes, I trust this folder', primary: true, auto: true, keys: [{ data: '1', delayAfterMs: 0 }] },
    { label: 'No, exit', keys: [{ data: '2', delayAfterMs: 0 }] },
  ],
}

/** A fake session: a virtual clock, so the real caps elapse in no wall time. */
function harness(opts: { outputAfterMs?: number; prompts?: (TuiPrompt | null)[]; alive?: boolean } = {}) {
  let clock = 0
  const writes: string[] = []
  const keys: string[] = []
  const prompts = [...(opts.prompts ?? [])]
  let seenPrompt: TuiPrompt | null | undefined
  const deps: ResumeSendDeps = {
    write: (d) => void writes.push(d),
    // Quiet the moment the boot has spoken: nothing else emits in the fake.
    isQuiet: () => opts.outputAfterMs != null && clock >= opts.outputAfterMs,
    sleep: async (ms) => {
      clock += ms
    },
    sawOutput: () => opts.outputAfterMs != null && clock >= opts.outputAfterMs,
    readPrompt: () => {
      seenPrompt = prompts.length > 0 ? prompts.shift()! : null
      return seenPrompt
    },
    runKeys: async (steps) => {
      for (const s of steps) keys.push(s.data)
    },
    isAlive: async () => opts.alive !== false,
  }
  return { deps, writes, keys, now: () => clock }
}

describe('deliverAfterResume', () => {
  it('types the message once the resumed process comes up', async () => {
    const h = harness({ outputAfterMs: 500 })
    const result = await deliverAfterResume(h.deps, 'ping', h.now)
    expect(result.delivered).toBe(true)
    expect(h.writes.join('')).toContain('\x1b[200~ping\x1b[201~')
    expect(h.writes.at(-1)).toBe('\r')
  })

  it('answers the folder-trust gate on the way in', async () => {
    const h = harness({ outputAfterMs: 500, prompts: [TRUST] })
    const result = await deliverAfterResume(h.deps, 'ping', h.now)
    expect(result.autoAnswered).toBe(1)
    // The affirmative option, not the "No, exit" one.
    expect(h.keys).toEqual(['1'])
    expect(h.writes.join('')).toContain('ping')
  })

  it('sends nothing when the resume never produced a process', async () => {
    const h = harness({})
    const result = await deliverAfterResume(h.deps, 'ping', h.now)
    expect(result.delivered).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('stops answering rather than typing at a prompt it cannot clear', async () => {
    const stubborn: TuiPrompt = { ...TRUST, options: [{ label: 'No, exit', keys: [{ data: '2', delayAfterMs: 0 }] }] }
    const h = harness({ outputAfterMs: 500, prompts: [stubborn] })
    const result = await deliverAfterResume(h.deps, 'ping', h.now)
    expect(result.autoAnswered).toBe(0)
    expect(h.keys).toEqual([])
  })

  it('does not type when the daemon has no PTY for the session', async () => {
    // The killed process's own death rattle can pass for the resumed one's
    // first output; the liveness check is what catches that.
    const h = harness({ outputAfterMs: 500, alive: false })
    const result = await deliverAfterResume(h.deps, 'ping', h.now)
    expect(result.delivered).toBe(false)
    expect(h.writes).toEqual([])
  })
})
