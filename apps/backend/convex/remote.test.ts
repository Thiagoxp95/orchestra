import { describe, expect, it } from "bun:test";
import { isSupersededPush } from "./remote";

const NOW = 1_700_000_000_000;

describe("isSupersededPush", () => {
  it("accepts a newer push", () => {
    expect(isSupersededPush(NOW, NOW - 1000, NOW)).toBe(false);
  });

  it("accepts a re-push carrying the same stamp", () => {
    expect(isSupersededPush(NOW, NOW, NOW)).toBe(false);
  });

  it("drops a replayed push older than the stored one", () => {
    expect(isSupersededPush(NOW - 18 * 60_000, NOW, NOW)).toBe(true);
  });

  it("drops the whole backlog of a reconnect replay, keeping the newest", () => {
    // The stall that motivated this: ~18min of queued pushes replayed in order.
    const stored = NOW;
    const backlog = [18, 12, 6, 1].map((min) => NOW - min * 60_000);
    for (const seq of backlog) {
      expect(isSupersededPush(seq, stored, NOW)).toBe(true);
    }
    expect(isSupersededPush(NOW + 1, stored, NOW)).toBe(false);
  });

  it("accepts when the row has no stored stamp yet (pre-migration row)", () => {
    expect(isSupersededPush(NOW, undefined, NOW)).toBe(false);
  });

  it("accepts a push from an older desktop that sends no stamp", () => {
    expect(isSupersededPush(undefined, NOW, NOW)).toBe(false);
  });

  it("heals from a stored stamp left implausibly far in the future", () => {
    // A skewed client clock must not wedge the mirror permanently.
    const skewed = NOW + 24 * 60 * 60_000;
    expect(isSupersededPush(NOW, skewed, NOW)).toBe(false);
  });

  it("still drops a replay when the stored stamp is only slightly ahead", () => {
    // Inside the tolerance band this is ordinary clock jitter, not real skew.
    expect(isSupersededPush(NOW - 60_000, NOW + 30_000, NOW)).toBe(true);
  });
});
