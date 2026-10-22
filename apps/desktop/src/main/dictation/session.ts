// src/main/dictation/session.ts
//
// One dictation, worked on while it's recorded. The phone streams the audio as
// the user talks; each stretch up to a pause goes to the ears then, and at each
// pause the transcript so far is cleaned ahead. The user stops talking a beat
// before letting go of the button, so when nothing was said after the last
// pause, that clean is the answer and the LLM's second went by before release.

import { tidy } from './cleanup'

export interface SessionDeps {
  /** Text for 16 kHz mono PCM16. Calls are answered in the order made. */
  hear: (pcm: Buffer) => Promise<string>
  /** [raw] (tidied) as written text; throws when the LLM can't be reached. */
  clean: (raw: string) => Promise<string>
}

export interface DictationResult {
  text: string
  raw: string
  /** "llm" when cleaned, "rules" when only tidied. */
  how: 'llm' | 'rules'
  /** Whether the clean made at the last pause was the answer. */
  ahead: boolean
  parts: number
  /** From the end of the audio to the answer. */
  ms: number
}

type Work = Omit<DictationResult, 'ahead' | 'parts' | 'ms'>

const FRAME = 640 // 20 ms of 16 kHz PCM16
const QUIET = 20 // frames: a 0.4 s pause ends a stretch
const LEAST = 3 * 32_000 // bytes: no stretch under 3 s, or the ears lose the sentence around a word
const SPOKE = 5 // loud frames since the last clean ahead that make it stale: 100 ms, more than a click

function rms(frame: Buffer): number {
  let sum = 0
  for (let i = 0; i < frame.length; i += 2) {
    const x = frame.readInt16LE(i)
    sum += x * x
  }
  return Math.sqrt(sum / (frame.length / 2))
}

export class DictationSession {
  private pending = Buffer.alloc(0)
  private scanned = 0
  private quiet = 0
  private floor = Infinity
  private loud = 0
  private readonly parts: Promise<string>[] = []
  private guess: Promise<Work> | null = null

  constructor(private readonly deps: SessionDeps) {}

  feed(data: Buffer): void {
    this.pending = Buffer.concat([this.pending, data])
    while (this.scanned + FRAME <= this.pending.length) {
      const level = rms(this.pending.subarray(this.scanned, this.scanned + FRAME))
      this.floor = Math.min(this.floor, level)
      this.scanned += FRAME
      const loud = level >= Math.max(300, this.floor * 3)
      this.quiet = loud ? 0 : this.quiet + 1
      if (loud) this.loud += 1
      if (this.quiet !== QUIET) continue // once a pause
      if (this.scanned >= LEAST) {
        const cut = this.scanned - (this.quiet * FRAME) / 2 // mid-pause
        const part = this.deps.hear(Buffer.from(this.pending.subarray(0, cut)))
        part.catch(() => {}) // awaited by whichever work reads it
        this.parts.push(part)
        this.pending = Buffer.from(this.pending.subarray(cut))
        this.scanned -= cut
      }
      if (this.loud >= SPOKE) {
        this.guess = this.work([...this.parts], Buffer.from(this.pending))
        this.guess.catch(() => {})
        this.loud = 0
      }
    }
  }

  /** (raw, text, how) for the stretches heard and the audio after them. */
  private async work(parts: Promise<string>[], pending: Buffer): Promise<Work> {
    const tail = this.deps.hear(pending)
    const heard = await Promise.all([...parts, tail])
    const raw = heard.map((t) => t.trim()).filter(Boolean).join(' ')
    const tidied = tidy(raw)
    if (!tidied) return { raw, text: '', how: 'rules' }
    try {
      return { raw, text: await this.deps.clean(tidied), how: 'llm' }
    } catch (err) {
      console.warn(`[dictation] cleanup failed, kept the transcript: ${err instanceof Error ? err.message : err}`)
      return { raw, text: tidied, how: 'rules' }
    }
  }

  async finish(): Promise<DictationResult> {
    const stopped = Date.now()
    const ahead = this.guess !== null && this.loud < SPOKE
    const result = ahead ? await this.guess! : await this.work(this.parts, this.pending)
    return { ...result, ahead, parts: this.parts.length + 1, ms: Date.now() - stopped }
  }
}
