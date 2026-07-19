import { describe, expect, it } from "bun:test";
import { canAppendChunk, isChunkWithinLimit, MAX_PCM_CHUNK_B64 } from "./dictationLogic";

describe("canAppendChunk", () => {
  it("allows appending while recording", () => {
    expect(canAppendChunk("recording")).toBe(true);
  });
  it("rejects appending once ended/done/cancelled", () => {
    expect(canAppendChunk("ended")).toBe(false);
    expect(canAppendChunk("done")).toBe(false);
    expect(canAppendChunk("cancelled")).toBe(false);
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
