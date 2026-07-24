// Pure audio helpers for remote dictation. The desktop sidecar's contract is
// 16kHz mono PCM16, base64 for transport over Convex.
//
// The preferred path is to ask for `new AudioContext({ sampleRate: 16000 })` so
// the browser's own (properly filtered) resampler does the work and we capture
// 16k natively. `StreamResampler` is the fallback for browsers that ignore the
// hint and hand back the hardware rate.

export const TARGET_SAMPLE_RATE = 16000
export const CHUNK_MS = 400

/** Number of input-rate samples in one upload chunk. */
export function samplesPerChunk(rate: number): number {
  return Math.round((rate * CHUNK_MS) / 1000)
}

/** Float [-1,1] → int16, clamped. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Int16 PCM → base64 of its little-endian bytes. */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  const CHUNK = 0x8000 // avoid String.fromCharCode arg-count overflow
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** RBJ cookbook biquad low-pass. Two in series ≈ 24 dB/oct. */
class BiquadLowPass {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = ((1 - cos) / 2) / a0
    this.b1 = (1 - cos) / a0
    this.b2 = this.b0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  step(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

// Nyquist for 16k is 8k; roll off just under it so the transition band is done
// before anything can fold back.
const ANTI_ALIAS_CUTOFF_HZ = 7200

/**
 * Stateful downsampler to 16k. Two properties the old per-call
 * `downsampleTo16k` lacked, both of which fed Parakeet degraded audio:
 *
 *  - **Anti-aliasing.** Decimating 48k→16k by plain interpolation folds
 *    everything above 8kHz back down into the speech band as noise. A phone mic
 *    has plenty of energy up there (sibilance, handling noise), and the model
 *    hears it as garbage.
 *  - **Continuous phase.** Resampling each ~400ms block independently restarts
 *    the read position at 0 every time, so every chunk boundary was a small
 *    discontinuity — a click train at 2.5Hz through the whole utterance.
 */
export class StreamResampler {
  private readonly ratio: number
  private readonly passthrough: boolean
  private readonly stage1: BiquadLowPass | null
  private readonly stage2: BiquadLowPass | null
  private phase = 0
  private tail = 0

  constructor(inputRate: number) {
    this.passthrough = !(inputRate > TARGET_SAMPLE_RATE) || !Number.isFinite(inputRate)
    this.ratio = inputRate / TARGET_SAMPLE_RATE
    this.stage1 = this.passthrough ? null : new BiquadLowPass(inputRate, ANTI_ALIAS_CUTOFF_HZ)
    this.stage2 = this.passthrough ? null : new BiquadLowPass(inputRate, ANTI_ALIAS_CUTOFF_HZ)
  }

  process(input: Float32Array): Float32Array {
    if (this.passthrough || input.length === 0) return input
    const n = input.length
    const filtered = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      filtered[i] = this.stage2!.step(this.stage1!.step(input[i]))
    }
    // Index -1 addresses the previous block's final sample, so interpolation
    // spans the block boundary instead of resetting at it.
    const out = new Float32Array(Math.ceil((n + 1) / this.ratio) + 1)
    let count = 0
    let pos = this.phase
    while (pos < n - 1) {
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const a = i0 < 0 ? this.tail : filtered[i0]
      const b = filtered[i0 + 1]
      out[count++] = a + (b - a) * frac
      pos += this.ratio
    }
    this.phase = pos - n
    this.tail = filtered[n - 1]
    return out.subarray(0, count)
  }
}

/**
 * Stateless linear-interpolation downsample. Retained for callers that resample
 * a whole buffer in one shot; streaming capture should use `StreamResampler`.
 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input
  if (inputRate < TARGET_SAMPLE_RATE) return input // never upsample; caller shouldn't hit this
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/**
 * Peak level of a block, used to decide whether an utterance contained speech
 * at all. A hold that captured only room tone should surface "no speech" rather
 * than let the model hallucinate a sentence out of noise.
 */
export function peakLevel(input: Float32Array): number {
  let peak = 0
  for (let i = 0; i < input.length; i++) {
    const a = Math.abs(input[i])
    if (a > peak) peak = a
  }
  return peak
}
