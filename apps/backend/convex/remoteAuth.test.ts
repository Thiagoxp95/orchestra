import { describe, expect, it } from "bun:test";
import { checkCredentials } from "./remoteAuth";

describe("checkCredentials", () => {
  it("accepts an exact email+password match", () => {
    expect(checkCredentials("me@x.com", "pw", "me@x.com", "pw")).toBe(true);
  });
  it("rejects a wrong password", () => {
    expect(checkCredentials("me@x.com", "nope", "me@x.com", "pw")).toBe(false);
  });
  it("rejects a wrong email", () => {
    expect(checkCredentials("other@x.com", "pw", "me@x.com", "pw")).toBe(false);
  });
  it("is case-insensitive on email, exact on password", () => {
    expect(checkCredentials("ME@X.com", "pw", "me@x.com", "pw")).toBe(true);
    expect(checkCredentials("me@x.com", "PW", "me@x.com", "pw")).toBe(false);
  });
  it("rejects when env is unset", () => {
    expect(checkCredentials("me@x.com", "pw", undefined, undefined)).toBe(false);
  });
});
