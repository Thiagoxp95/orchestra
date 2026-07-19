// Pure, dependency-free helpers for the dictation transport. Kept out of the
// Convex function files so they unit-test under bun:test exactly like
// remoteAuth.ts's checkCredentials.

export type DictationStatus = "recording" | "ended" | "done" | "cancelled";

// A chunk may only be appended while the phone is still holding the button.
export function canAppendChunk(status: DictationStatus): boolean {
  return status === "recording";
}

// ~1s of 16kHz mono PCM16 base64 ≈ 43.7k chars. Cap generously above the
// largest chunk the client emits (~400ms) so a malformed/oversized upload is
// rejected before it bloats a Convex document.
export const MAX_PCM_CHUNK_B64 = 96_000;

export function isChunkWithinLimit(b64Length: number): boolean {
  return b64Length > 0 && b64Length <= MAX_PCM_CHUNK_B64;
}
