import { describe, expect, it } from "vitest";

import { hmac, normalizeApiError, normalizeEmail, redactSensitive, secureEqual, sha256 } from "../src/platform.js";
import { z } from "zod";

describe("platform security helpers", () => {
  it("normalizes email addresses", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("uses deterministic hashes and constant-time equality", () => {
    expect(sha256("value")).toHaveLength(64);
    expect(secureEqual(hmac("value"), hmac("value"))).toBe(true);
    expect(secureEqual(hmac("value"), hmac("other"))).toBe(false);
  });

  it("normalizes validation and unknown errors at the HTTP boundary", () => {
    const validation = normalizeApiError(z.object({ email: z.email() }).safeParse({ email: "bad" }).error);
    expect(validation.statusCode).toBe(422);
    expect(validation.code).toBe("VALIDATION_ERROR");
    expect(validation.details).toEqual({ fields: { email: ["Invalid email address"] } });

    const internal = normalizeApiError(new Error("database password"));
    expect(internal.statusCode).toBe(500);
    expect(internal.message).not.toContain("password");
  });

  it("redacts credentials before audit persistence", () => {
    expect(redactSensitive({ password: "secret", nested: { refresh_token: "token", safe: "value" } })).toEqual({
      password: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]", safe: "value" },
    });
  });
});
