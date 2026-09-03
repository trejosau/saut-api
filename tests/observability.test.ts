import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

import { config } from "../src/config.js";
import { createApp } from "../src/server.js";
import { RuntimeMetrics, runtimeMetrics } from "../src/observability.js";
import { fetchExternal } from "../src/platform.js";

describe("runtime observability metrics", () => {
  it("captures bounded HTTP latency, status error rates and provider timeouts", () => {
    const metrics = new RuntimeMetrics();
    const firstRequest = {} as FastifyRequest;
    const secondRequest = {} as FastifyRequest;

    metrics.startRequest(firstRequest);
    metrics.finishRequest(firstRequest, 200);
    metrics.startRequest(secondRequest);
    metrics.finishRequest(secondRequest, 503);
    metrics.recordProviderRequest("skydropx");
    metrics.recordProviderError("skydropx", new DOMException("deadline exceeded", "AbortError"), 503);

    const snapshot = metrics.snapshot({
      totalConnections: 2,
      idleConnections: 1,
      waitingRequests: 0,
      maxConnections: 10,
    });

    expect(snapshot.process.rssBytes).toBeGreaterThan(0);
    expect(snapshot.process.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.http.requestsTotal).toBe(2);
    expect(snapshot.http.errorsTotal).toBe(1);
    expect(snapshot.http.serverErrorsTotal).toBe(1);
    expect(snapshot.http.errorRate).toBe(0.5);
    expect(snapshot.http.latencyMs.count).toBe(2);
    expect(snapshot.http.latencyMs.p95).toBeGreaterThanOrEqual(snapshot.http.latencyMs.p50);
    expect(snapshot.providers.skydropx).toMatchObject({
      requestsTotal: 1,
      errorsTotal: 1,
      timeoutsTotal: 1,
      errorRate: 1,
      lastStatusCode: 503,
    });
  });

  it("records provider HTTP failures and timeout signals at the shared fetch boundary", async () => {
    const emptyPool = { totalConnections: 0, idleConnections: 0, waitingRequests: 0, maxConnections: 10 };
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
      const beforeHttpFailure = runtimeMetrics.snapshot(emptyPool).providers.test_provider;
      await fetchExternal("https://provider.invalid", {}, 100, "test_provider");
      const afterHttpFailure = runtimeMetrics.snapshot(emptyPool).providers.test_provider;

      expect(afterHttpFailure?.requestsTotal).toBe((beforeHttpFailure?.requestsTotal ?? 0) + 1);
      expect(afterHttpFailure?.errorsTotal).toBe((beforeHttpFailure?.errorsTotal ?? 0) + 1);
      expect(afterHttpFailure?.lastStatusCode).toBe(503);

      vi.stubGlobal("fetch", vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("deadline exceeded", "AbortError")), { once: true });
      })));
      const beforeTimeout = runtimeMetrics.snapshot(emptyPool).providers.timeout_provider;
      await expect(fetchExternal("https://provider.invalid", {}, 1, "timeout_provider")).rejects.toMatchObject({ statusCode: 503 });
      const afterTimeout = runtimeMetrics.snapshot(emptyPool).providers.timeout_provider;

      expect(afterTimeout?.timeoutsTotal).toBe((beforeTimeout?.timeoutsTotal ?? 0) + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("health, readiness and metrics endpoints", () => {
  const database = {
    ping: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    poolMetrics: vi.fn(() => ({
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 0,
      maxConnections: 10,
    })),
  };
  const redis = {
    status: "ready",
    ping: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
  const s3 = { send: vi.fn().mockResolvedValue({}) };
  let application!: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    database.ping.mockResolvedValue(undefined);
    application = await createApp({ database, redis, s3, stripe: {}, sockets: new Set() } as any);
  }, 30_000);

  afterAll(async () => {
    await application.nestApp.close();
  });

  it("keeps health public and liveness independent of infrastructure", async () => {
    const health = await application.app.inject({ method: "GET", url: "/health" });
    const live = await application.app.inject({ method: "GET", url: "/live" });

    expect(health.statusCode).toBe(200);
    expect(health.body).toBe("ok");
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: "ok", service: "saut-api" });
  });

  it("returns 503 when readiness dependencies fail without leaking the cause", async () => {
    database.ping.mockRejectedValueOnce(new Error("postgres password must not leak"));
    const response = await application.app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE", request_id: expect.any(String) });
    expect(response.body).not.toContain("password");
  });

  it("protects metrics with the existing internal API key and reports pool gauges", async () => {
    const unauthorized = await application.app.inject({ method: "GET", url: "/metrics" });
    const authorized = await application.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-internal-api-key": config.AUTH_INTERNAL_API_KEY },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");
    expect(authorized.json()).toMatchObject({
      process: { rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number) },
      http: { requestsTotal: expect.any(Number), latencyMs: { p95: expect.any(Number) } },
      dbPool: { totalConnections: 1, idleConnections: 1, waitingRequests: 0, maxConnections: 10 },
    });
  });
});
