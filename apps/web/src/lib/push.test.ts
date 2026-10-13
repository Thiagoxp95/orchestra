import { describe, expect, it } from "vitest";
import { sameApplicationServerKey, shouldAutoResubscribe, urlBase64ToUint8Array } from "./push";

describe("urlBase64ToUint8Array", () => {
  it("decodes url-safe base64 to the right byte length", () => {
    // "hello" base64url = "aGVsbG8"
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});

describe("shouldAutoResubscribe", () => {
  it("resubscribes when installed and permission already granted", () => {
    expect(shouldAutoResubscribe("granted", true)).toBe(true);
  });

  it("never prompts: default permission does not auto-resubscribe", () => {
    expect(shouldAutoResubscribe("default", true)).toBe(false);
  });

  it("respects denied permission", () => {
    expect(shouldAutoResubscribe("denied", true)).toBe(false);
  });

  it("skips browser tabs (not installed as a PWA)", () => {
    expect(shouldAutoResubscribe("granted", false)).toBe(false);
  });
});

describe("sameApplicationServerKey", () => {
  const key = new Uint8Array([4, 1, 2, 3]);

  it("matches a subscription made with the same key", () => {
    expect(sameApplicationServerKey(new Uint8Array([4, 1, 2, 3]).buffer, key)).toBe(true);
  });

  it("flags a subscription made with a rotated key", () => {
    expect(sameApplicationServerKey(new Uint8Array([4, 9, 9, 9]).buffer, key)).toBe(false);
  });

  it("treats a missing key as a mismatch", () => {
    expect(sameApplicationServerKey(null, key)).toBe(false);
  });
});
