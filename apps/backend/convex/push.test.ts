import { describe, expect, it } from "bun:test";
import { buildPushPayload, isExpiredPushError } from "./push";

describe("buildPushPayload", () => {
  it("serializes the notification fields to JSON", () => {
    const json = buildPushPayload({
      title: "Fix the bug",
      body: "needs input",
      sessionId: "s1",
      requiresUserInput: true,
    });
    expect(JSON.parse(json)).toEqual({
      title: "Fix the bug",
      body: "needs input",
      sessionId: "s1",
      requiresUserInput: true,
    });
  });
});

describe("isExpiredPushError", () => {
  it("treats 404 and 410 as expired", () => {
    expect(isExpiredPushError(404)).toBe(true);
    expect(isExpiredPushError(410)).toBe(true);
  });
  it("treats other codes as not expired", () => {
    expect(isExpiredPushError(500)).toBe(false);
    expect(isExpiredPushError(201)).toBe(false);
  });
});
