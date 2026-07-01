import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/server.js";

const contract = `
GET /health
POST /auth/email/start
POST /auth/email/verify
POST /auth/email/consume
GET /auth/google/start
POST /auth/google/exchange
GET /api/auth/google/start
GET /api/auth/google/callback
POST /auth/token/refresh
POST /auth/session/revoke
GET /auth/me
GET /admin/auth/audit-log
GET /admin/auth/accounts
GET /admin/auth/roles
GET /admin/auth/permissions
GET /admin/auth/accounts/{account_id}/access
POST /admin/auth/accounts/{account_id}/status
POST /admin/auth/accounts/{account_id}/roles
DELETE /admin/auth/accounts/{account_id}/roles/{role_code}
POST /admin/auth/accounts/{account_id}/permission-overrides
DELETE /admin/auth/accounts/{account_id}/permission-overrides/{screen}/{action}
GET /catalog/publications
GET /catalog/publications/{slug}
GET /catalog/collections
GET /catalog/collections/{slug}
GET /catalog/drops
GET /catalog/drops/{slug}
GET /catalog/season
POST /cart/sessions
GET /cart/sessions/{cart_id}
POST /cart/sessions/{cart_id}/items/predesigned
POST /cart/sessions/{cart_id}/items/customized
DELETE /cart/sessions/{cart_id}/items/{item_id}
POST /checkout/sessions
GET /checkout/sessions/{checkout_id}
POST /checkout/sessions/{checkout_id}/shipping/select
POST /payments/attempts
GET /payments/attempts/{attempt_id}
POST /payments/attempts/{attempt_id}/cancel
POST /payments/attempts/{attempt_id}/confirm
GET /orders/{order_id}
GET /orders/by-checkout/{checkout_id}
GET /orders/lookup
GET /admin/orders
GET /admin/orders/{order_id}
GET /admin/orders/{order_id}/work-orders
PATCH /admin/work-orders/{work_order_id}/checklist
POST /admin/work-orders/{work_order_id}/merma
PATCH /ops/orders/{order_id}/status
GET /inventory/items
GET /inventory/stock
GET /inventory/items/{id}/movements
GET /pricing/sku
POST /webhooks/shipping/skydropx
GET /support/chat/reasons
GET /support/cases
POST /support/cases
GET /support/cases/{case_id}
POST /support/cases/{case_id}/messages
GET /analytics/map/pings
POST /analytics/customizer/events
GET /assets/{asset_id}/resolve
GET /assets/{asset_id}/download
PUT /assets/{asset_id}/upload
GET /admin/catalog/publications
POST /admin/catalog/publications
GET /admin/catalog/publications/{id}
PATCH /admin/catalog/publications/{id}
POST /admin/catalog/publications/{id}
DELETE /admin/catalog/publications/{id}
GET /admin/catalog/publications/{id}/mockups
POST /admin/catalog/publications/{id}/mockups
PATCH /admin/catalog/publications/{id}/mockups/{mockup_id}
DELETE /admin/catalog/publications/{id}/mockups/{mockup_id}
POST /admin/catalog/publications/{id}/publish
POST /admin/catalog/publications/{id}/unpublish
GET /admin/catalog/designs
POST /admin/catalog/designs
GET /admin/catalog/designs/{id}
PATCH /admin/catalog/designs/{id}
DELETE /admin/catalog/designs/{id}
GET /admin/catalog/design-variants
POST /admin/catalog/design-variants
GET /admin/catalog/design-variants/{id}
PATCH /admin/catalog/design-variants/{id}
DELETE /admin/catalog/design-variants/{id}
GET /admin/catalog/informative-images
POST /admin/catalog/informative-images
GET /admin/catalog/informative-images/{id}
PATCH /admin/catalog/informative-images/{id}
DELETE /admin/catalog/informative-images/{id}
GET /admin/catalog/collections
POST /admin/catalog/collections
GET /admin/catalog/collections/{id}
PATCH /admin/catalog/collections/{id}
DELETE /admin/catalog/collections/{id}
PUT /admin/catalog/collections/{id}/items
GET /admin/catalog/drops
POST /admin/catalog/drops
GET /admin/catalog/drops/{id}
PATCH /admin/catalog/drops/{id}
DELETE /admin/catalog/drops/{id}
PUT /admin/catalog/drops/{id}/items
POST /admin/catalog/season:toggle
POST /admin/catalog/season/toggle
GET /admin/inventory/items
GET /admin/inventory/movements
POST /admin/inventory/entries
POST /admin/inventory/entries/batch
POST /admin/inventory/adjustments
GET /admin/pricing/sku-rules
POST /admin/pricing/sku-rules
POST /admin/pricing/sku-rules/upsert
PATCH /admin/pricing/sku-rules/{id}
GET /admin/pricing/customizer-config
PUT /admin/pricing/customizer-config
POST /admin/pricing/quote-order
POST /admin/shipping/national/orders/{order_id}/shipment
POST /admin/shipping/national/orders/{order_id}/tracking/refresh
POST /admin/shipping/local/orders/{order_id}/ready
POST /admin/shipping/local/orders/{order_id}/out-for-delivery
POST /admin/shipping/local/orders/{order_id}/delivered
POST /admin/shipping/local/orders/{order_id}/failed
PATCH /admin/shipping/local/orders/{order_id}/address
PATCH /shipping/local/orders/{order_id}/address
GET /admin/shipping/local/routes/today
GET /admin/shipping/shipments
POST /admin/assets/sign-upload
POST /admin/assets/{asset_id}/sign-read
GET /admin/assets/{asset_id}/resolve
GET /admin/notifications/deliveries
POST /admin/notifications/deliveries/{delivery_id}/retry
GET /admin/analytics/kpis
GET /admin/support/cases
GET /admin/support/cases/{case_id}
PATCH /admin/support/cases/{case_id}/status
POST /admin/support/cases/{case_id}/messages
POST /admin/support/cases/{case_id}/refunds
`.trim().split("\n").map((line) => {
  const [method, path] = line.trim().split(" ");
  return { method, url: path!.replaceAll(/\{([^}]+)\}/g, ":$1") };
});

let application: Awaited<ReturnType<typeof createApp>>;
let app: Awaited<ReturnType<typeof createApp>>["app"];

beforeAll(async () => {
  const fakeContext: any = { database: {}, redis: { status: "ready" }, s3: {}, stripe: {}, sockets: new Set() };
  application = await createApp(fakeContext);
  app = application.app;
});

afterAll(async () => {
  await application.nestApp.close();
});

describe("legacy gateway contract", () => {
  it("runs on a NestJS application", () => {
    expect(application.nestApp.getHttpAdapter().getType()).toBe("fastify");
  });

  it("keeps every method and route", () => {
    expect(contract).toHaveLength(138);
    for (const route of contract) {
      expect(app.hasRoute(route as any), `${route.method} ${route.url}`).toBe(true);
    }
  });
});
