// Backpressure for in-flight dictation audio. Ported from stablyai/orca (MIT),
// `mobile/src/hooks/mobile-dictation-pending-audio-budget.ts`.
//
// Why: a chunk upload can sit waiting through a Convex reconnect before it
// times out. On a weak mobile link the mic keeps producing 400ms of audio every
// 400ms regardless, so unacknowledged chunks pile up unbounded — first as raw
// PCM, then expanded ~1.33x into base64 strings. Cap the retained audio and fail
// the utterance loudly, because the alternative is a transcript assembled from
// whatever subset of chunks happened to survive.

export const PCM_SAMPLE_RATE = 16000
const PCM_BYTES_PER_SAMPLE = 2
const MAX_PENDING_AUDIO_SECONDS = 5

export const MAX_PENDING_AUDIO_BYTES =
  PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * MAX_PENDING_AUDIO_SECONDS

export const CONNECTION_SLOW_ERROR =
  'Connection too slow for voice. Try again when the signal improves.'

export class PendingAudioBudget {
  private pendingBytes = 0

  constructor(private readonly maxPendingBytes = MAX_PENDING_AUDIO_BYTES) {}

  get pendingAudioBytes(): number {
    return this.pendingBytes
  }

  tryReserve(byteLength: number): boolean {
    const n = normalize(byteLength)
    if (this.pendingBytes + n > this.maxPendingBytes) return false
    this.pendingBytes += n
    return true
  }

  release(byteLength: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - normalize(byteLength))
  }

  reset(): void {
    this.pendingBytes = 0
  }
}

function normalize(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0
  return Math.floor(byteLength)
}
