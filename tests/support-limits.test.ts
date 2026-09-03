import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerSupportAnalytics } from "../src/modules/support-analytics.js";

function supportApp() {
  const database = { query: vi.fn(), connect: vi.fn() };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => reply.status(Number((error as { statusCode?: number }).statusCode ?? 500)).send({ message: error instanceof Error ? error.message : String(error) }));
  return registerSupportAnalytics(app, {
    database: database as never,
    redis: {} as never,
    s3: {} as never,
    stripe: {} as never,
    sockets: new Set(),
  }).then(() => ({ app, database }));
}

describe("support payload limits", () => {
  it("rejects a missing or oversized message before persistence", async () => {
    const { app, database } = await supportApp();
    const response = await app.inject({ method: "POST", url: "/support/cases", payload: { contact_email: "user@example.com" } });
    const oversized = await app.inject({ method: "POST", url: "/support/cases", payload: { contact_email: "user@example.com", message: "x".repeat(4_001) } });
    await app.close();

    expect(response.statusCode).toBe(422);
    expect(oversized.statusCode).toBe(422);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("bounds attachments and subject size", async () => {
    const { app, database } = await supportApp();
    const tooManyAttachments = await app.inject({
      method: "POST",
      url: "/support/cases",
      payload: { contact_email: "user@example.com", message: "Necesito ayuda", attachments: Array.from({ length: 11 }, () => ({})) },
    });
    const oversizedSubject = await app.inject({
      method: "POST",
      url: "/support/cases",
      payload: { contact_email: "user@example.com", message: "Necesito ayuda", subject: "x".repeat(201) },
    });
    await app.close();

    expect(tooManyAttachments.statusCode).toBe(422);
    expect(oversizedSubject.statusCode).toBe(422);
    expect(database.query).not.toHaveBeenCalled();
  });
});
