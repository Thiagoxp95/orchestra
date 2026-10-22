import { describe, expect, it, vi } from 'vitest'
import { acceptCleanup, tidy } from './cleanup'
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

describe('DictationSession', () => {
  it('hears each stretch at its pause and the tail at the end, in order', async () => {
    const hear = vi.fn(async (pcm: Buffer) => `part${pcm.length > 100_000 ? 'A' : 'B'}`)
    const clean = vi.fn(async (raw: string) => `${raw}.`)
    const session = new DictationSession({ hear, clean })
    // Room tone first: the noise floor is learned from the quietest frame so far.
    session.feed(Buffer.concat([audio(0.2, 50), audio(3.5, 4000), audio(0.5, 50)]))
    session.feed(audio(1, 4000))
    const result = await session.finish()
    expect(result.parts).toBe(2)
    expect(result.text).toBe('PartA partB.')
    expect(result.how).toBe('llm')
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
