import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { database } = vi.hoisted(() => ({
  database: {
    query: vi.fn(),
  },
}));

vi.mock("../src/db.js", () => ({
  database,
  closeDatabase: vi.fn(),
  pingDatabase: vi.fn(),
}));

import { registerAuth } from "../src/modules/auth.js";
import { signAccessToken, verifyAccessToken } from "../src/platform.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

function activeAccountAndSession(revokedAt: Date | null = null, expiresAt = new Date(Date.now() + 60_000)) {
  database.query
    .mockResolvedValueOnce({ rows: [{ actor_type: "customer", status: "active" }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ account_id: accountId, revoked_at: revokedAt, expires_at: expiresAt }], rowCount: 1 })
    .mockResolvedValue({ rows: [], rowCount: 0 });
}

async function authRoutes(redis: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    reply.status(Number((error as { statusCode?: number }).statusCode ?? 500)).send({ error });
  });
  await registerAuth(app, {
    database: database as never,
    redis: redis as never,
    s3: {} as never,
    stripe: {} as never,
    sockets: new Set(),
  });
  return app;
}

describe("session-backed access tokens", () => {
  beforeEach(() => {
    database.query.mockReset();
  });

  it("accepts an active, unexpired session and loads current account access", async () => {
    activeAccountAndSession();
    const token = await signAccessToken({ accountId, actorType: "customer", sessionId });

    await expect(verifyAccessToken(token)).resolves.toMatchObject({
      accountId,
      actorType: "customer",
      sessionId,
      roles: [],
      permissions: [],
    });
  });

  it.each([
    ["revoked", new Date(), new Date(Date.now() + 60_000)],
    ["expired", null, new Date(Date.now() - 1_000)],
  ])("rejects a %s session even when the JWT is still valid", async (_label, revokedAt, expiresAt) => {
    activeAccountAndSession(revokedAt, expiresAt);
    const token = await signAccessToken({ accountId, actorType: "customer", sessionId });

    await expect(verifyAccessToken(token)).rejects.toMatchObject({ statusCode: 401 });
    expect(database.query).toHaveBeenCalledTimes(2);
  });
});

describe("refresh rotation and self-revocation", () => {
  beforeEach(() => {
    database.query.mockReset();
  });

  it("rotates the refresh hash with an atomic current-token predicate", async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ session_id: sessionId, account_id: accountId, actor_type: "customer", primary_email: "user@example.com" }],
      rowCount: 1,
    });
    const app = await authRoutes();
    const oldToken = "a".repeat(64);

    const response = await app.inject({
      method: "POST",
      url: "/auth/token/refresh",
      payload: { refresh_token: oldToken },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.account_id).toBe(accountId);
    expect(body.session_id).toBe(sessionId);
    expect(body.refresh_token).not.toBe(oldToken);
    expect(String(database.query.mock.calls[0]?.[0])).toContain("s.refresh_token_hash = $1");
    expect(String(database.query.mock.calls[0]?.[0])).toContain("previous_refresh_token_hash");
  });

  it("reuses a coordinated refresh result for concurrent BFF requests", async () => {
    const cached = {
      account_id: accountId,
      session_id: sessionId,
      actor_type: "customer",
      primary_email: "user@example.com",
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in_sec: 900,
      session_expires_in_sec: 86_400,
    };
    const redis = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cached)),
      del: vi.fn(),
      set: vi.fn(),
      eval: vi.fn(),
    };
    database.query.mockResolvedValueOnce({ rows: [{ id: sessionId }], rowCount: 1 });
    const app = await authRoutes(redis);

    const response = await app.inject({
      method: "POST",
      url: "/auth/token/refresh",
      headers: { "x-refresh-client": "d".repeat(32) },
      payload: { refresh_token: "d".repeat(64) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cached);
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("revokes a session when a rotated refresh token is reused", async () => {
    database.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: sessionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const app = await authRoutes();

    const response = await app.inject({
      method: "POST",
      url: "/auth/token/refresh",
      payload: { refresh_token: "b".repeat(64) },
    });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(database.query.mock.calls[2]?.[1]).toEqual([sessionId, "refresh_token_reuse"]);
  });

  it("revokes only a session identified by an access or refresh credential", async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: sessionId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const app = await authRoutes();

    const response = await app.inject({
      method: "POST",
      url: "/auth/session/revoke",
      payload: { refresh_token: "c".repeat(64) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: true });

    database.query.mockReset();
    const missingCredential = await app.inject({
      method: "POST",
      url: "/auth/session/revoke",
      payload: { session_id: sessionId },
    });
    await app.close();

    expect(missingCredential.statusCode).toBe(401);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("revokes all active sessions when an account is disabled", async () => {
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
    database.query.mockResolvedValueOnce({
      rows: [{ account_id: accountId, actor_type: "customer", status: "blocked", revoked_sessions: 2 }],
      rowCount: 1,
    });
    const app = await authRoutes();

    const response = await app.inject({
      method: "POST",
      url: `/admin/auth/accounts/${accountId}/status`,
      payload: { status: "BLOCKED" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "blocked", revoked_sessions: 2 });
    expect(String(database.query.mock.calls[0]?.[0])).toContain("update sessions");
    expect(database.query.mock.calls[0]?.[1]).toEqual([accountId, "blocked", "account_status_changed"]);
  });
});
