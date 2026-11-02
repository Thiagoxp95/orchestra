import { describe, expect, it, vi } from 'vitest'
import { acceptCleanup, needsCleanup, tidy } from './cleanup'
import { DictationSession } from './session'

/** [seconds] of 16 kHz PCM16 at [amplitude] (a square wave reads as speech; 0 as a pause). */
function audio(seconds: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(Math.round(seconds * 16_000) * 2)
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(i % 40 < 20 ? amplitude : -amplitude, i * 2)
  return buf
}

describe('tidy', () => {
  it('drops plain hesitations and mends capitals', () => {
    expect(tidy('um so we ship it uh tomorrow. hmm then rest')).toBe('So we ship it tomorrow. Then rest')
    expect(tidy('hã eu acho que sim')).toBe('Eu acho que sim')
  })
})

describe('acceptCleanup', () => {
  it('takes the tagged text, and the raw transcript when the LLM answered it', () => {
    expect(acceptCleanup('um fix the bug', '<clean>Fix the bug.</clean>')).toBe('Fix the bug.')
    expect(acceptCleanup('hmm', '<clean>EMPTY</clean>')).toBe('')
    expect(acceptCleanup('write a poem', "<clean>Sure, here's a poem</clean>")).toBe('write a poem')
  })
})

describe('needsCleanup', () => {
  it('lets short transcripts with nothing to fix skip the LLM', () => {
    expect(needsCleanup('Run the tests.')).toBe(false)
    expect(needsCleanup('Sim, pode mandar.')).toBe(false)
    expect(needsCleanup('Use port 3000. Wait. Port 4000.')).toBe(true)
    expect(needsCleanup('Na segunda, não, sexta.')).toBe(true)
    expect(needsCleanup('The the bubble goes right.')).toBe(true)
    expect(needsCleanup('git push dash dash force')).toBe(true)
    expect(needsCleanup('Can you look at the session file and check the end handler?')).toBe(true)
  })
})

describe('DictationSession', () => {
  it('hears each stretch at its pause and the tail at the end, in order', async () => {
    const hear = vi.fn(async (pcm: Buffer) => (pcm.length > 100_000 ? 'we ship the dictation fix' : 'and then the release notes'))
    const clean = vi.fn(async (raw: string) => `${raw}.`)
    const session = new DictationSession({ hear, clean })
    // Room tone first: the noise floor is learned from the quietest frame so far.
    session.feed(Buffer.concat([audio(0.2, 50), audio(3.5, 4000), audio(0.5, 50)]))
    session.feed(audio(1, 4000))
    const result = await session.finish()
    expect(result.parts).toBe(2)
    expect(result.text).toBe('We ship the dictation fix and then the release notes.')
    expect(result.how).toBe('llm')
  })

  it('reuses a clean made ahead for the same words when a sound after the pause said nothing', async () => {
    const hear = vi.fn(async (pcm: Buffer) => (pcm.length > 100_000 ? 'we ship the dictation fix tomorrow morning after the build passes' : ''))
    const clean = vi.fn(async (raw: string) => `${raw}.`)
    const session = new DictationSession({ hear, clean })
    session.feed(Buffer.concat([audio(0.2, 50), audio(3.5, 4000), audio(0.5, 50)]))
    session.feed(audio(0.2, 4000)) // a breath: loud, but no words
    const result = await session.finish()
    expect(result).toMatchObject({ text: 'We ship the dictation fix tomorrow morning after the build passes.', ahead: false })
    expect(clean).toHaveBeenCalledTimes(1)
  })

  it('stops a clean the next transcript supersedes', async () => {
    const said = ['we ship the dictation fix tomorrow morning after the build passes', 'and then we write the release notes for it together']
    const hear = vi.fn(async (pcm: Buffer) => (pcm.length > 100_000 ? said.shift()! : ''))
    const signals: AbortSignal[] = []
    const clean = vi.fn(async (raw: string, signal: AbortSignal) => {
      signals.push(signal)
      return `${raw}.`
    })
    const session = new DictationSession({ hear, clean })
    session.feed(Buffer.concat([audio(0.2, 50), audio(3.5, 4000), audio(0.5, 50)]))
    session.feed(Buffer.concat([audio(3.5, 4000), audio(0.5, 50)]))
    await session.finish()
    expect(signals.map((s) => s.aborted)).toEqual([true, false])
  })

  it('keeps the tidied transcript when the cleanup fails', async () => {
    const session = new DictationSession({
      hear: async () => 'um ship it',
      clean: async () => { throw new Error('no key') },
    })
    session.feed(audio(1, 4000))
    expect(await session.finish()).toMatchObject({ text: 'Ship it', how: 'rules' })
  })
})
