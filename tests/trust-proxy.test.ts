import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";

describe("trusted proxy hop boundary", () => {
  const originalHops = config.TRUST_PROXY_HOPS;

  afterEach(() => {
    config.TRUST_PROXY_HOPS = originalHops;
  });

  it("does not accept a spoofed forwarded client IP when running directly", async () => {
    config.TRUST_PROXY_HOPS = 0;
    const app = Fastify({ trustProxy: (_address, hop) => hop < config.TRUST_PROXY_HOPS });
    app.get("/ip", request => request.ip);

    const response = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "203.0.113.10" } });
    await app.close();

    expect(response.body).toBe("127.0.0.1");
  });

  it("accepts one forwarded hop only when explicitly configured", async () => {
    config.TRUST_PROXY_HOPS = 1;
    const app = Fastify({ trustProxy: (_address, hop) => hop < config.TRUST_PROXY_HOPS });
    app.get("/ip", request => request.ip);

    const response = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "203.0.113.10" } });
    await app.close();

    expect(response.body).toBe("203.0.113.10");
  });
});
