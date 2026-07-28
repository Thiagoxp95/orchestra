import { describe, expect, it } from "bun:test";
import { AGENT_MESSAGE_CAP, clampPageLimit, isSupersededPush, messageOverflow } from "./remote";

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

// Rows only need identity + order for the overflow decision; seq stands in
// for the full document the mutation actually deletes.
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i }));

describe("messageOverflow", () => {
  it("deletes nothing for an empty session", () => {
    expect(messageOverflow([])).toEqual([]);
  });

  it("deletes nothing under the cap", () => {
    expect(messageOverflow(rows(AGENT_MESSAGE_CAP - 1))).toEqual([]);
  });

  it("deletes nothing exactly at the cap", () => {
    expect(messageOverflow(rows(AGENT_MESSAGE_CAP))).toEqual([]);
  });

  it("evicts the single lowest-seq row one over the cap", () => {
    expect(messageOverflow(rows(AGENT_MESSAGE_CAP + 1))).toEqual([{ seq: 0 }]);
  });

  it("evicts a whole batch worth of head rows after a max-size append", () => {
    // A full 40-message append onto an already-full session must trim back to
    // exactly the cap, oldest first.
    const out = messageOverflow(rows(AGENT_MESSAGE_CAP + 40));
    expect(out.length).toBe(40);
    expect(out[0]).toEqual({ seq: 0 });
    expect(out[out.length - 1]).toEqual({ seq: 39 });
  });

  it("respects an explicit cap", () => {
    expect(messageOverflow(rows(5), 3)).toEqual([{ seq: 0 }, { seq: 1 }]);
  });
});

describe("clampPageLimit", () => {
  it("passes an ordinary page size through", () => {
    expect(clampPageLimit(60)).toBe(60);
  });

  it("caps at the server maximum", () => {
    expect(clampPageLimit(5000)).toBe(100);
  });

  it("floors fractional sizes", () => {
    expect(clampPageLimit(59.9)).toBe(59);
  });

  it("never asks the query for a non-positive page", () => {
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(-7)).toBe(1);
  });

  it("degrades a non-finite size to a full page instead of throwing", () => {
    expect(clampPageLimit(Number.NaN)).toBe(100);
    expect(clampPageLimit(Number.POSITIVE_INFINITY)).toBe(100);
  });
});
