import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { database } = vi.hoisted(() => ({ database: { query: vi.fn() } }));

vi.mock("../src/db.js", () => ({ database, closeDatabase: vi.fn(), pingDatabase: vi.fn() }));

import {
  decodeBase32,
  decryptTotpSecret,
  encryptTotpSecret,
  encodeBase32,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  requireStepUp,
  registerAdvancedAuth,
  requiresMfa,
  verifyTotpCode,
} from "../src/modules/advanced-auth.js";
import { signAccessToken } from "../src/platform.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("TOTP and recovery-code primitives", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    const secret = encodeBase32(Buffer.from("12345678901234567890", "ascii"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(generateTotpCode(secret, 1)).toBe("287082");
    expect(verifyTotpCode(secret, "287082", 30_000, 0)).toBe(1);
    expect(decodeBase32(secret).toString("ascii")).toBe("12345678901234567890");
  });

  it("encrypts TOTP secrets and emits high-entropy one-time recovery codes", () => {
    const secret = generateTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(secret))).toBe(secret);
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/.test(code))).toBe(true);
  });

  it("only requires MFA for the configured policy scope", () => {
    expect(requiresMfa({ mode: "disabled", required_roles: [], step_up_ttl_sec: 300 }, ["admin"])).toBe(false);
    expect(requiresMfa({ mode: "required_all", required_roles: [], step_up_ttl_sec: 300 }, ["customer"])).toBe(true);
    expect(requiresMfa({ mode: "required_roles", required_roles: ["admin"], step_up_ttl_sec: 300 }, ["admin"])).toBe(true);
    expect(requiresMfa({ mode: "required_roles", required_roles: ["admin"], step_up_ttl_sec: 300 }, ["customer"])).toBe(false);
  });

  it("honors the policy TTL when validating a step-up", () => {
    const actor = {
      accountId,
      actorType: "admin",
      sessionId,
      roles: ["admin"],
      permissions: [],
      stepUpVerifiedAt: new Date(Date.now() - 120_000),
    };
    expect(() => requireStepUp(actor, 60)).toThrowError(expect.objectContaining({ statusCode: 403 }));
    expect(() => requireStepUp(actor, 180)).not.toThrow();
  });
});

describe("advanced auth integration routes", () => {
  beforeEach(() => {
    database.query.mockReset();
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  async function app(redis: Record<string, unknown> = {}) {
    const server = Fastify({ logger: false });
    server.setErrorHandler((error, _request, reply) => reply.status(Number((error as { statusCode?: number }).statusCode ?? 500)).send({ error }));
    await registerAdvancedAuth(server, {
      database: database as never,
      redis: redis as never,
      s3: {} as never,
      stripe: {} as never,
      sockets: new Set(),
    });
    return server;
  }

  function queueAuthenticatedActor() {
    database.query
      .mockResolvedValueOnce({ rows: [{ actor_type: "customer", status: "active" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ account_id: accountId, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ mfa_verified_at: new Date(), step_up_verified_at: null, step_up_method: null, mfa_enabled: true, mfa_mode: "optional", required_roles: [] }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  }

  it("reports status without exposing the encrypted secret or recovery material", async () => {
    queueAuthenticatedActor();
    database.query
      .mockResolvedValueOnce({ rows: [{ enabled: true, pending_secret_encrypted: null, secret_encrypted: "encrypted", last_totp_step: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ mode: "optional", required_roles: [], step_up_ttl_sec: 300 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 10 }], rowCount: 1 });
    const server = await app();
    const token = await signAccessToken({ accountId, actorType: "customer", sessionId });
    const response = await server.inject({ method: "GET", url: "/auth/mfa/status", headers: { authorization: `Bearer ${token}` } });
    await server.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, recovery_codes_remaining: 10 });
    expect(response.body).not.toContain("encrypted");
  });

  it("creates a one-time step-up challenge with the requested purpose", async () => {
    queueAuthenticatedActor();
    database.query
      .mockResolvedValueOnce({ rows: [{ enabled: true, pending_secret_encrypted: null, secret_encrypted: "encrypted", last_totp_step: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ mode: "optional", required_roles: [], step_up_ttl_sec: 300 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 10 }], rowCount: 1 });
    const redis = { set: vi.fn().mockResolvedValue("OK") };
    const server = await app(redis);
    const token = await signAccessToken({ accountId, actorType: "customer", sessionId });
    const response = await server.inject({ method: "POST", url: "/auth/step-up/start", headers: { authorization: `Bearer ${token}` }, payload: { purpose: "change-email" } });
    await server.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ expires_in_sec: 300, methods: ["totp", "recovery_code"] });
    expect(redis.set).toHaveBeenCalledOnce();
  });
});
