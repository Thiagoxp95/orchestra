// Pure, dependency-free helpers for the dictation transport. Kept out of the
// Convex function files so they unit-test under bun:test exactly like
// remoteAuth.ts's checkCredentials.

export type DictationStatus =
  | "recording"
  | "ended"
  | "done"
  | "cancelled"
  | "error";

// A chunk may only be appended while the phone is still holding the button.
export function canAppendChunk(status: DictationStatus): boolean {
  return status === "recording";
}

// A terminal status is one nothing may transition away from — it guards
// finalize/fail against a late desktop write racing a user cancel.
export function isTerminalStatus(status: DictationStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}

// ~1s of 16kHz mono PCM16 base64 ≈ 43.7k chars. Cap generously above the
// largest chunk the client emits (~400ms) so a malformed/oversized upload is
// rejected before it bloats a Convex document.
export const MAX_PCM_CHUNK_B64 = 96_000;

export function isChunkWithinLimit(b64Length: number): boolean {
  return b64Length > 0 && b64Length <= MAX_PCM_CHUNK_B64;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// Python's `base64.b64decode` and JS's `Buffer.from(x, 'base64')` both silently
// drop or truncate malformed input rather than raising, so a corrupted upload
// would reach Parakeet as garbage PCM and come back as a garbled transcript.
// Reject it at the boundary instead. Borrowed from stablyai/orca (MIT), which
// validates the same way on its dictation chunk RPC.
export function isValidAudioBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_PATTERN.test(value);
}
