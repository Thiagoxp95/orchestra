import { describe, expect, it } from "vitest";
import { shouldAutoResubscribe, urlBase64ToUint8Array } from "./push";

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
