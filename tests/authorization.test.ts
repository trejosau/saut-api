import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
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
import { registerCatalog } from "../src/modules/catalog.js";
import { registerOperations } from "../src/modules/operations.js";
import { registerSupportAnalytics } from "../src/modules/support-analytics.js";
import { permissionForPath, requirePermission, signAccessToken } from "../src/platform.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const otherOrderId = "33333333-3333-4333-8333-333333333333";

function context(redis: Record<string, unknown> = {}) {
  return {
    database: database as never,
    redis: { getdel: vi.fn(), set: vi.fn(), ...redis } as never,
    s3: {} as never,
    stripe: {} as never,
    sockets: new Set(),
  } as never;
}

function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    reply.status(Number((error as { statusCode?: number }).statusCode ?? 500)).send({
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function configureTokenAccess(permissions: string[] = [], primaryEmail = "actor@example.com", roles: string[] = []) {
  database.query.mockImplementation(async (sql: string) => {
    const normalized = sql.replaceAll(/\s+/g, " ").toLowerCase();
    if (normalized.includes("select actor_type, status from accounts")) {
      return { rows: [{ actor_type: "customer", status: "active" }], rowCount: 1 };
    }
    if (normalized.includes("select account_id, revoked_at, expires_at from sessions")) {
      return { rows: [{ account_id: accountId, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }], rowCount: 1 };
    }
    if (normalized.includes("select r.code from account_roles")) {
      return { rows: roles.map((code) => ({ code })), rowCount: roles.length };
    }
    if (normalized.includes("with role_grants")) {
      return { rows: permissions.map((key) => ({ key })), rowCount: permissions.length };
    }
    if (normalized.includes("select primary_email from accounts")) {
      return { rows: [{ primary_email: primaryEmail }], rowCount: 1 };
    }
    if (normalized.includes("select * from orders where id=$1")) {
      return {
        rows: [{
          id: otherOrderId,
          customer_email: "different-owner@example.com",
          customer_access_token_hash: "not-used",
        }],
        rowCount: 1,
      };
    }
    if (normalized.includes("select * from sales_pings")) {
      return { rows: [{ id: "ping-1", order_id: otherOrderId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function accessToken() {
  return signAccessToken({ accountId, actorType: "customer", sessionId });
}

describe("authorization boundaries", () => {
  beforeEach(() => {
    database.query.mockReset();
  });

  it("does not treat the admin role as an implicit permission wildcard", () => {
    expect(() => requirePermission({
      accountId,
      actorType: "admin",
      sessionId,
      roles: ["admin"],
      permissions: [],
    }, "payments:refund")).toThrowError(expect.objectContaining({ statusCode: 403 }));

    expect(() => requirePermission({
      accountId,
      actorType: "admin",
      sessionId,
      roles: ["admin"],
      permissions: ["payments:refund"],
    }, "payments:refund")).not.toThrow();
  });

  it.each([
    ["/admin/support/cases/case/refunds", "POST", "payments:refund"],
    ["/admin/notifications/deliveries/delivery/retry", "POST", "notifications:write"],
    ["/admin/assets/asset/resolve", "GET", "assets:read"],
    ["/admin/assets/sign-upload", "POST", "assets:write"],
    ["/admin/pricing/quote-order", "POST", "pricing:read"],
  ])("maps %s %s to %s", (path, method, permission) => {
    expect(permissionForPath(path, method)).toBe(permission);
  });

  it("denies unknown admin paths instead of granting an implicit role access", () => {
    expect(permissionForPath("/admin/unknown-resource", "GET")).toBeUndefined();
  });

  it("requires analytics authentication and the explicit read permission", async () => {
    const app = Fastify({ logger: false });
    errorHandler(app);
    await app.register(websocket);
    const redis = { getdel: vi.fn(), set: vi.fn() };
    await registerSupportAnalytics(app, context(redis));

    const unauthenticated = await app.inject({ method: "GET", url: "/analytics/map/pings" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(database.query).not.toHaveBeenCalled();

    configureTokenAccess([]);
    const token = await accessToken();
    const forbidden = await app.inject({
      method: "GET",
      url: "/analytics/map/pings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("select * from sales_pings"))).toBe(false);

    configureTokenAccess(["analytics:read"]);
    const allowed = await app.inject({
      method: "GET",
      url: "/analytics/map/pings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual([{ id: "ping-1", order_id: otherOrderId }]);

    await app.close();
  });

  it("issues a short-lived analytics ticket only to an analytics reader", async () => {
    configureTokenAccess(["analytics:read"]);
    const token = await accessToken();
    const redis = { getdel: vi.fn(), set: vi.fn().mockResolvedValue("OK") };
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerSupportAnalytics(app, context(redis));

    const response = await app.inject({
      method: "POST",
      url: "/internal/analytics/ws-ticket",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ticket).toEqual(expect.any(String));
    expect(body.expires_in_sec).toBe(60);
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^analytics:ws:/), token, "EX", 60);

    await app.close();
  });

  it("does not let a customer link another customer's order to a support case", async () => {
    configureTokenAccess([], "actor@example.com");
    const token = await accessToken();
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerSupportAnalytics(app, context());

    const response = await app.inject({
      method: "POST",
      url: "/support/cases",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        order_id: otherOrderId,
        contact_email: "different-owner@example.com",
        message: "Intento de vincular pedido ajeno",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("insert into support_cases"))).toBe(false);
    await app.close();
  });

  it("protects inventory movement history and keeps public inventory projection non-sensitive", async () => {
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerOperations(app, context());

    const unauthenticated = await app.inject({ method: "GET", url: "/inventory/items/item-1/movements" });
    expect(unauthenticated.statusCode).toBe(401);

    database.query.mockResolvedValue({ rows: [{ id: "item-1", quantity: 4 }], rowCount: 1 });
    const publicItems = await app.inject({ method: "GET", url: "/inventory/items" });
    expect(publicItems.statusCode).toBe(200);
    expect(publicItems.json()).toEqual([{ id: "item-1", quantity: 4 }]);
    expect(publicItems.json()[0]).not.toHaveProperty("supplier_cost_mxn");
    expect(String(database.query.mock.calls.at(-1)?.[0])).toContain("select id,garment_type,garment_model,color,size,grammage_g,fit,quantity");
    await app.close();
  });

  it("does not expose hidden catalog publications, collections, or drops through public details", async () => {
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerCatalog(app, context());

    for (const url of [
      "/catalog/publications/hidden-publication",
      "/catalog/collections/hidden-collection",
      "/catalog/drops/hidden-drop",
    ]) {
      database.query.mockResolvedValue({ rows: [], rowCount: 0 });
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }

    const queries = database.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.some((sql) => sql.includes("p.is_active=true") && sql.includes("p.visibility in ('public','visible')"))).toBe(true);
    expect(queries.some((sql) => sql.includes("collections_sets where slug=$1 and visibility in ('public','visible')"))).toBe(true);
    expect(queries.some((sql) => sql.includes("drops where slug=$1 and visibility in ('public','visible')"))).toBe(true);
    await app.close();
  });

  it("does not let a mockup id cross its publication boundary", async () => {
    database.query.mockImplementation(async (sql: string) => {
      const normalized = sql.replaceAll(/\s+/g, " ").toLowerCase();
      if (normalized.includes("update publication_mockups")) return { rows: [], rowCount: 0 };
      if (normalized.includes("delete from publication_mockups")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerCatalog(app, context());

    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/catalog/publications/publication-a/mockups/mockup-b",
      payload: { mockup_url: "https://attacker.invalid/repointed" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: "/admin/catalog/publications/publication-a/mockups/mockup-b",
    });

    expect(patch.statusCode).toBe(404);
    expect(remove.statusCode).toBe(404);
    const queries = database.query.mock.calls.map(([sql]) => String(sql).replaceAll(/\s+/g, " ").toLowerCase());
    expect(queries.some((sql) => sql.includes("where id=$2 and publication_id=$3"))).toBe(true);
    expect(queries.some((sql) => sql.includes("where id=$1 and publication_id=$2"))).toBe(true);
    await app.close();
  });

  it("does not expose internal pricing costs on the public SKU route", async () => {
    const fullRow = {
      id: "sku-1",
      garment_type: "tshirt",
      garment_model: "oversize",
      color: "Negra",
      size: "M",
      grammage_g: 240,
      fit: "",
      sale_price_mxn: 699,
      provider_price_mxn: 150,
      dtf_cost_mxn: 80,
      packaging_cost_mxn: 25,
      is_active: true,
    };
    database.query.mockImplementation(async (sql: string) => {
      const isPublicProjection = sql.toLowerCase().includes("select id,garment_type,garment_model,color,size,grammage_g,fit,sale_price_mxn");
      const publicRow = {
        id: fullRow.id,
        garment_type: fullRow.garment_type,
        garment_model: fullRow.garment_model,
        color: fullRow.color,
        size: fullRow.size,
        grammage_g: fullRow.grammage_g,
        fit: fullRow.fit,
        sale_price_mxn: fullRow.sale_price_mxn,
      };
      return { rows: [isPublicProjection ? publicRow : fullRow], rowCount: 1 };
    });
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerOperations(app, context());

    const response = await app.inject({ method: "GET", url: "/pricing/sku" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ id: "sku-1", sale_price_mxn: 699 }));
    expect(response.json()).not.toHaveProperty("provider_price_mxn");
    expect(response.json()).not.toHaveProperty("dtf_cost_mxn");
    expect(response.json()).not.toHaveProperty("packaging_cost_mxn");
    expect(String(database.query.mock.calls[0]?.[0])).toContain("select id,garment_type,garment_model,color,size,grammage_g,fit,sale_price_mxn");
    await app.close();
  });

  it("does not allow an admin role to pass internal authorization without the requested permission", async () => {
    configureTokenAccess([], "actor@example.com", ["admin"]);
    const token = await accessToken();
    const app = Fastify({ logger: false });
    errorHandler(app);
    await registerAuth(app, context());

    const response = await app.inject({
      method: "POST",
      url: "/internal/authorize",
      payload: { token, screen: "payments", action: "refund" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowed).toBe(false);
    await app.close();
  });
});
