import { describe, expect, it } from "vitest";

import type { FastifyRequest } from "fastify";

import {
  asObject,
  bearerToken,
  hmac,
  HttpError,
  normalizeEmail,
  pagination,
  randomToken,
  requirePermission,
  secureEqual,
  sha256,
} from "../src/platform.js";

describe("platform security helpers", () => {
  it("normalizes email addresses", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("uses deterministic hashes and constant-time equality", () => {
    expect(sha256("value")).toHaveLength(64);
    expect(secureEqual(hmac("value"), hmac("value"))).toBe(true);
    expect(secureEqual(hmac("value"), hmac("other"))).toBe(false);
    expect(secureEqual("short", "a-longer-value")).toBe(false);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("normalizes objects and pagination at the HTTP boundary", () => {
    expect(asObject(null)).toEqual({});
    expect(asObject(["not", "an", "object"])).toEqual({});
    expect(asObject({ value: 1 })).toEqual({ value: 1 });
    expect(pagination({ limit: 999, offset: -4 })).toEqual({ limit: 200, offset: 0 });
    expect(pagination({ limit: "20", offset: "5" })).toEqual({ limit: 20, offset: 5 });
  });

  it("extracts bearer credentials and enforces explicit permissions", () => {
    expect(bearerToken({ headers: { authorization: "Bearer token-1" } } as FastifyRequest)).toBe("token-1");
    expect(bearerToken({ headers: {} } as FastifyRequest)).toBeNull();
    expect(() => requirePermission({
      accountId: "admin", actorType: "admin", roles: ["admin"], permissions: [],
    }, "catalog:write")).not.toThrow();
    expect(() => requirePermission({
      accountId: "user", actorType: "customer", roles: [], permissions: ["catalog:read"],
    }, "catalog:write")).toThrow(HttpError);
  });
});
