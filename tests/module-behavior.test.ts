import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAuth } from "../src/modules/auth.js";
import { registerAssets } from "../src/modules/assets.js";
import { registerCatalog } from "../src/modules/catalog.js";
import { registerCommerce } from "../src/modules/commerce.js";
import { registerOperations } from "../src/modules/operations.js";
import { registerSupportAnalytics } from "../src/modules/support-analytics.js";
import { createRouteTestContext, result } from "./helpers/context.js";

const applications: ReturnType<typeof Fastify>[] = [];

async function applicationWith(
  register: (app: ReturnType<typeof Fastify>, context: ReturnType<typeof createRouteTestContext>["context"]) => Promise<void>
) {
  const mocks = createRouteTestContext();
  const app = Fastify({ logger: false });
  applications.push(app);
  await register(app, mocks.context);
  return { app, ...mocks };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("critical HTTP module behavior with isolated data access", () => {
  it("creates and reads an empty cart without a real database", async () => {
    const { app, query } = await applicationWith(registerCommerce);
    query.mockImplementation(async (sql) => {
      if (sql.includes("select * from carts")) {
        return result([{ id: "cart-1", status: "active" }]);
      }
      if (sql.includes("select * from cart_items")) return result([]);
      return result([]);
    });

    const response = await app.inject({ method: "POST", url: "/cart/sessions", payload: { guest_session_id: "guest-1" } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(expect.objectContaining({ id: "cart-1", total_items: 0, subtotal_mxn: 0 }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into carts"), expect.any(Array));
  });

  it("rejects invalid commerce state and rolls back missing payments", async () => {
    const { app, query, transactionQuery, release } = await applicationWith(registerCommerce);
    query.mockImplementation(async (sql) => {
      if (sql.includes("select * from carts")) return result([{ id: "cart-1", status: "active" }]);
      if (sql.includes("select * from cart_items")) return result([]);
      return result([]);
    });

    const assets = Array.from({ length: 11 }, (_, index) => ({ asset_id: `asset-${index}` }));
    const customized = await app.inject({
      method: "POST",
      url: "/cart/sessions/cart-1/items/customized",
      payload: { front_assets: assets, back_assets: [] },
    });
    expect(customized.statusCode).toBe(400);

    const checkout = await app.inject({
      method: "POST",
      url: "/checkout/sessions",
      payload: { cart_id: "cart-1", address: { city: "Torreón" } },
    });
    expect(checkout.statusCode).toBe(400);

    transactionQuery.mockImplementation(async (sql) => sql === "begin" || sql === "rollback" ? result([]) : result([]));
    const payment = await app.inject({
      method: "POST",
      url: "/payments/attempts",
      payload: { checkout_session_id: "missing" },
    });
    expect(payment.statusCode).toBe(404);
    expect(transactionQuery).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("validates auth inputs and emits a development login challenge", async () => {
    const { app, query } = await applicationWith(registerAuth);
    query.mockResolvedValue(result([]));

    const invalid = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: "invalid" } });
    expect(invalid.statusCode).toBe(500);

    const valid = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: " USER@example.com " } });
    expect(valid.statusCode).toBe(202);
    expect(valid.json()).toEqual(expect.objectContaining({ status: "sent", delivery: "dev" }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("login_challenges"), ["user@example.com"]);
  });

  it("handles auth throttling, invalid verification and internal validation", async () => {
    const { app, query } = await applicationWith(registerAuth);
    query.mockResolvedValueOnce(result([{ last_sent_at: new Date() }]));
    const throttled = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: "user@example.com" } });
    expect(throttled.statusCode).toBe(429);

    query.mockResolvedValue(result([]));
    const verification = await app.inject({
      method: "POST",
      url: "/auth/email/verify",
      payload: { email: "user@example.com", code: "123456" },
    });
    expect(verification.statusCode).toBe(401);

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/token/refresh",
      payload: { refresh_token: "x".repeat(40) },
    });
    expect(refresh.statusCode).toBe(401);

    const revoke = await app.inject({ method: "POST", url: "/auth/session/revoke", payload: {} });
    expect(revoke.statusCode).toBe(400);

    const validation = await app.inject({ method: "POST", url: "/internal/validate-token", payload: { token: "invalid" } });
    expect(validation.json()).toEqual(expect.objectContaining({ valid: false, account_id: null }));
  });

  it("creates a local checkout and exposes not-found payment/order errors", async () => {
    const { app, query } = await applicationWith(registerCommerce);
    query.mockImplementation(async (sql) => {
      if (sql.includes("select * from carts")) return result([{ id: "cart-1", status: "active" }]);
      if (sql.includes("select * from cart_items")) {
        return result([{ id: "line-1", cart_id: "cart-1", quantity: 2, unit_price_mxn: 250 }]);
      }
      if (sql.includes("select * from checkout_sessions")) {
        return result([{
          id: "checkout-1",
          cart_id: "cart-1",
          shipping_quotes: [{ quote_id: "local-standard", provider: "saut-local", service: "local", price_mxn: 79 }],
        }]);
      }
      return result([]);
    });

    const checkout = await app.inject({
      method: "POST",
      url: "/checkout/sessions",
      payload: {
        cart_id: "cart-1",
        email: "buyer@example.com",
        phone: "5555555555",
        address: { city: "Torreón", state: "Coahuila", postal_code: "27000", line1: "Calle 1" },
      },
    });
    expect(checkout.statusCode).toBe(201);
    expect(checkout.json()).toEqual(expect.objectContaining({ id: "checkout-1", items: [expect.any(Object)] }));

    query.mockResolvedValue(result([]));
    expect((await app.inject({ method: "GET", url: "/payments/attempts/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/orders/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/cart/sessions/cart-1/items/predesigned", payload: {} })).statusCode).toBe(404);
  });

  it("validates asset signing and resolves public metadata", async () => {
    const { app, query } = await applicationWith(registerAssets);
    const unauthorized = await app.inject({ method: "POST", url: "/assets/sign-upload", payload: {} });
    expect(unauthorized.statusCode).toBe(401);

    const invalidType = await app.inject({
      method: "POST",
      url: "/admin/assets/sign-upload",
      payload: { content_type: "application/x-executable" },
    });
    expect(invalidType.statusCode).toBe(400);

    query.mockResolvedValue(result([]));
    const signed = await app.inject({
      method: "POST",
      url: "/admin/assets/sign-upload",
      payload: { content_type: "image/webp", category: "mockup", file_name: "drop 01.webp" },
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json()).toEqual(expect.objectContaining({ method: "PUT", upload_url: expect.stringContaining("/assets/") }));

    query.mockResolvedValueOnce(result([{
      id: "asset-1", visibility: "public", content_type: "image/webp", size_bytes: 120,
    }]));
    const resolved = await app.inject({ method: "GET", url: "/assets/asset-1/resolve" });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual(expect.objectContaining({ asset_id: "asset-1", public_url: expect.stringContaining("asset-1") }));

    const invalidUpload = await app.inject({
      method: "PUT",
      url: "/assets/asset-1/upload",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(invalidUpload.statusCode).toBe(401);
  });

  it("returns catalog lists and explicit not-found errors", async () => {
    const { app, query } = await applicationWith(registerCatalog);
    query.mockResolvedValue(result([]));

    const list = await app.inject({ method: "GET", url: "/catalog/publications?category=sports" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    const missing = await app.inject({ method: "GET", url: "/catalog/publications/missing" });
    expect(missing.statusCode).toBe(404);

    const season = await app.inject({ method: "GET", url: "/catalog/season" });
    expect(season.json()).toEqual({ is_enabled: false });
  });

  it("calculates inventory and pricing responses and validates work orders", async () => {
    const { app, query } = await applicationWith(registerOperations);
    query.mockImplementation(async (sql) => {
      if (sql.includes("coalesce(sum(quantity)")) return result([{ quantity: "4" }]);
      return result([]);
    });

    const stock = await app.inject({
      method: "GET",
      url: "/inventory/stock?garment_type=tshirt&color=Negra&size=M&grammage_g=240",
    });
    expect(stock.json()).toEqual({ quantity: 4 });

    const quote = await app.inject({
      method: "POST",
      url: "/admin/pricing/quote-order",
      payload: { items: [{ unit_price_mxn: 250, quantity: 2 }, { sale_price_mxn: 100 }] },
    });
    expect(quote.json()).toEqual(expect.objectContaining({ subtotal_mxn: 600, total_mxn: 600 }));

    const checklist = await app.inject({ method: "PATCH", url: "/admin/work-orders/missing/checklist", payload: {} });
    expect(checklist.statusCode).toBe(404);
  });

  it("protects support identity and accepts analytics events", async () => {
    const { app, query } = await applicationWith(registerSupportAnalytics);
    query.mockResolvedValue(result([]));

    const reasons = await app.inject({ method: "GET", url: "/support/chat/reasons" });
    expect(reasons.statusCode).toBe(200);
    expect(reasons.json().reasons.length).toBeGreaterThan(0);

    const cases = await app.inject({ method: "GET", url: "/support/cases" });
    expect(cases.statusCode).toBe(400);

    const notification = await app.inject({ method: "POST", url: "/notifications/email/login-code", payload: {} });
    expect(notification.statusCode).toBe(400);

    const event = await app.inject({
      method: "POST",
      url: "/analytics/customizer/events",
      payload: { event_type: "design_saved", publication_id: "publication-1" },
    });
    expect(event.statusCode).toBe(202);
    expect(event.json()).toEqual(expect.objectContaining({ accepted: true }));
  });
});
