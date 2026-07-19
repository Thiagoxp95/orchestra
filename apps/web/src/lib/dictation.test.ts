import { describe, expect, it } from 'vitest'
import {
  downsampleTo16k,
  floatTo16BitPCM,
  int16ToBase64,
  samplesPerChunk,
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
