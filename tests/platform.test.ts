import { describe, expect, it } from "vitest";

import { hmac, normalizeEmail, secureEqual, sha256 } from "../src/platform.js";

describe("platform security helpers", () => {
  it("normalizes email addresses", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("uses deterministic hashes and constant-time equality", () => {
    expect(sha256("value")).toHaveLength(64);
    expect(secureEqual(hmac("value"), hmac("value"))).toBe(true);
    expect(secureEqual(hmac("value"), hmac("other"))).toBe(false);
  });
});
