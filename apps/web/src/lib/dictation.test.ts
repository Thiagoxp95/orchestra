import { describe, expect, it } from 'vitest'
import {
  downsampleTo16k,
  floatTo16BitPCM,
  int16ToBase64,
  peakLevel,
  samplesPerChunk,
  StreamResampler,
  TARGET_SAMPLE_RATE,
} from './dictation'

describe('floatTo16BitPCM', () => {
  it('maps the float range to int16 and clamps', () => {
    const out = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768])
  })
})

describe('downsampleTo16k', () => {
  it('returns input unchanged when already 16k', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo16k(input, TARGET_SAMPLE_RATE)).toBe(input)
  })
  it('reduces length by the rate ratio (48k → 16k = /3)', () => {
    const input = new Float32Array(48000).fill(0.5)
    const out = downsampleTo16k(input, 48000)
    expect(out.length).toBe(16000)
  })
})

describe('int16ToBase64', () => {
  it('round-trips through atob to the original little-endian bytes', () => {
    const pcm = new Int16Array([0, 256, -1])
    const b64 = int16ToBase64(pcm)
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    // 0x0000, 0x0100, 0xFFFF little-endian
    expect(Array.from(bytes)).toEqual([0, 0, 0, 1, 255, 255])
  })
})

describe('samplesPerChunk', () => {
  it('is 400ms worth of samples at 16k', () => {
    expect(samplesPerChunk(TARGET_SAMPLE_RATE)).toBe(6400)
  })
})

describe('peakLevel', () => {
  it('is the largest magnitude in the block', () => {
    expect(peakLevel(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7)
    expect(peakLevel(new Float32Array(128))).toBe(0)
  })
})

/** Sums a sine at `hz` sampled at `rate`, one block. */
function sine(hz: number, rate: number, samples: number, startPhase = 0): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = Math.sin(2 * Math.PI * hz * ((i + startPhase) / rate))
  return out
}

describe('StreamResampler', () => {
  it('passes 16k input straight through', () => {
    const r = new StreamResampler(TARGET_SAMPLE_RATE)
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(r.process(input)).toBe(input)
  })

  it('produces roughly rate-ratio fewer samples', () => {
    const r = new StreamResampler(48000)
    // 1s of 48k across 400ms-ish blocks.
    let total = 0
    for (let i = 0; i < 25; i++) total += r.process(new Float32Array(1920)).length
    // 48000 in → ~16000 out; allow a couple of samples of boundary slack.
    expect(total).toBeGreaterThan(15990)
    expect(total).toBeLessThan(16010)
  })

  it('attenuates content above the 8k Nyquist instead of folding it into speech', () => {
    // A 12kHz tone at 48k aliases to 4kHz — right in the middle of the speech
    // band — if you decimate without filtering first. That noise is what the
    // model used to hear on top of the voice.
    const naive = downsampleTo16k(sine(12000, 48000, 48000), 48000)
    const filtered = new StreamResampler(48000).process(sine(12000, 48000, 48000))
    // Skip the filter's settling transient.
    expect(peakLevel(filtered.subarray(2000))).toBeLessThan(peakLevel(naive.subarray(2000)) * 0.2)
  })

  it('keeps speech-band content', () => {
    const out = new StreamResampler(48000).process(sine(1000, 48000, 48000))
    expect(peakLevel(out.subarray(2000))).toBeGreaterThan(0.7)
  })

  it('does not discontinuity-click at block boundaries', () => {
    // Resampling each block independently restarted the read phase at 0 every
    // time, putting a step into the signal at every chunk edge.
    const rate = 48000
    const blockSize = 1920
    const r = new StreamResampler(rate)
    const out: number[] = []
    for (let b = 0; b < 20; b++) {
      const block = sine(440, rate, blockSize, b * blockSize)
      for (const s of r.process(block)) out.push(s)
    }
    // A clean 440Hz sine at 16k steps by at most ~0.18 between samples; any
    // boundary discontinuity shows up as a much larger jump.
    let maxStep = 0
    for (let i = 2000; i < out.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]))
    }
    expect(maxStep).toBeLessThan(0.25)
  })
})
