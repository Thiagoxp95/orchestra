// Pure audio helpers for remote dictation. The browser mic runs at the
// AudioContext's native rate (commonly 48k); we downsample to 16k mono PCM16
// to match the desktop sidecar's audio contract, then base64-encode for Convex.

export const TARGET_SAMPLE_RATE = 16000
export const CHUNK_MS = 400

/** Number of 16k samples in one upload chunk. */
export function samplesPerChunk(rate: number): number {
  return Math.round((rate * CHUNK_MS) / 1000)
}

/** Linear-interpolation downsample to 16k. Returns input untouched if already 16k. */
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
