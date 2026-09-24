// src/shared/dictation.ts
//
// Pure helpers for the dictation transport, kept dependency-free so they unit
// test on their own.

export type DictationStatus = 'recording' | 'ended' | 'done' | 'cancelled' | 'error'

/**
 * Id prefix for an utterance dictated into the CHAT composer rather than the
 * terminal. The transcript belongs in the chat draft — the phone reads it back
 * off `dictationStatus` — so the desktop must not type it into the session's
 * PTY (in chat view that PTY is an idle shell; the text would land in zsh).
 * Mirrors the existing `stream:<lease>:` convention on terminal utterances.
 */
export const CHAT_DICTATION_PREFIX = 'chat:'

export function isChatDictation(dictationId: string): boolean {
  return dictationId.startsWith(CHAT_DICTATION_PREFIX)
}

/** ~1s of 16kHz mono PCM16 base64 ≈ 43.7k chars. Capped generously above the
 *  largest chunk the phone emits (~400ms) so a malformed or oversized upload
 *  is rejected at the boundary. */
export const MAX_PCM_CHUNK_B64 = 96_000

export function isChunkWithinLimit(b64Length: number): boolean {
  return b64Length > 0 && b64Length <= MAX_PCM_CHUNK_B64
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Python's `base64.b64decode` and JS's `Buffer.from(x, 'base64')` both silently
 * drop or truncate malformed input rather than raising, so a corrupted upload
 * would reach the transcriber as garbage PCM and come back as a garbled
 * transcript. Reject it at the boundary instead.
 */
export function isValidAudioBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_PATTERN.test(value)
}
