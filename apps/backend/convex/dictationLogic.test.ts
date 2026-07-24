import { describe, expect, it } from "bun:test";
import {
  canAppendChunk,
  isChunkWithinLimit,
  isTerminalStatus,
  isValidAudioBase64,
  MAX_PCM_CHUNK_B64,
} from "./dictationLogic";

describe("canAppendChunk", () => {
  it("allows appending while recording", () => {
    expect(canAppendChunk("recording")).toBe(true);
  });
  it("rejects appending once ended/done/cancelled/error", () => {
    expect(canAppendChunk("ended")).toBe(false);
    expect(canAppendChunk("done")).toBe(false);
    expect(canAppendChunk("cancelled")).toBe(false);
    expect(canAppendChunk("error")).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it("treats settled outcomes as terminal", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("error")).toBe(true);
  });
  it("leaves in-flight states writable", () => {
    // The desktop finalizes against these; a cancel that lands first must win.
    expect(isTerminalStatus("recording")).toBe(false);
    expect(isTerminalStatus("ended")).toBe(false);
  });
});

describe("isValidAudioBase64", () => {
  it("accepts well-formed base64", () => {
    expect(isValidAudioBase64(btoa("\x01\x00\x02\x00"))).toBe(true);
    expect(isValidAudioBase64("AAAA")).toBe(true);
    expect(isValidAudioBase64("AAA=")).toBe(true);
    expect(isValidAudioBase64("AA==")).toBe(true);
  });
  it("rejects payloads the decoders would silently mangle", () => {
    // b64decode drops these characters instead of raising, so the corruption
    // would only show up as a garbled transcript.
    expect(isValidAudioBase64("not base64!")).toBe(false);
    expect(isValidAudioBase64("AAAAA")).toBe(false); // length % 4 === 1
    expect(isValidAudioBase64("AA=A")).toBe(false);
  });
});

describe("isChunkWithinLimit", () => {
  it("accepts a normal ~400ms chunk", () => {
    // 400ms @ 16kHz mono int16 = 12800 bytes → base64 ≈ 17068 chars
    expect(isChunkWithinLimit(17068)).toBe(true);
  });
  it("rejects an oversized chunk", () => {
    expect(isChunkWithinLimit(MAX_PCM_CHUNK_B64 + 1)).toBe(false);
  });
});
