/* global process, fetch, console */

import { WebSocket } from "ws";
import { createHmac } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";

const base = process.env.API_BASE_URL ?? "http://localhost:8080";
const skydropxSecret = process.env.SKYDROPX_WEBHOOK_SECRET ?? "skydropx_wh_mock";

async function request(method, path, body, extraHeaders) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? extraHeaders : { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
}

async function expectStatus(method, path, expectedStatus, body, extraHeaders) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? extraHeaders : { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path}: expected ${expectedStatus}, got ${response.status} ${await response.text()}`);
  }
}

async function issueAnalyticsTicket() {
  const email = (process.env.AUTH_ADMIN_EMAILS ?? "albertosaut@gmail.com").split(",")[0].trim();
  const started = await request("POST", "/auth/email/start", { email });
  if (!started.code) throw new Error("Development login code is unavailable for the realtime smoke test");
  const session = await request("POST", "/auth/email/verify", { email, code: started.code });
  const ticket = await request("POST", "/internal/analytics/ws-ticket", undefined, {
    authorization: `Bearer ${session.access_token}`,
    "x-internal-api-key": process.env.AUTH_INTERNAL_API_KEY ?? "dev-internal-auth-key"
  });
  if (!ticket.ticket) throw new Error("Analytics WebSocket ticket missing");
  return ticket.ticket;
}

function totpCode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  const counter = Math.floor(Date.now() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

async function verifyAdvancedAuth() {
  const email = `e2e-mfa-${Date.now()}@saut.local`;
  const started = await request("POST", "/auth/email/start", { email });
  const session = await request("POST", "/auth/email/verify", { email, code: started.code });
  const headers = { authorization: `Bearer ${session.access_token}` };
  const setup = await request("POST", "/auth/mfa/totp/setup", {}, headers);
  const enabled = await request("POST", "/auth/mfa/totp/verify", { code: totpCode(setup.secret) }, headers);
  if (!enabled.recovery_codes?.length) throw new Error("MFA recovery codes missing");
  const status = await request("GET", "/auth/mfa/status", undefined, headers);
  if (!status.enabled || status.recovery_codes_remaining !== enabled.recovery_codes.length) throw new Error("MFA status contract failed");
  const challenge = await request("POST", "/auth/step-up/start", { purpose: "e2e-check" }, headers);
  const steppedUp = await request("POST", "/auth/step-up/verify", { challenge_id: challenge.challenge_id, recovery_code: enabled.recovery_codes[0] }, headers);
  if (!steppedUp.verified || steppedUp.method !== "recovery_code") throw new Error("Step-up contract failed");
  await request("POST", "/auth/mfa/disable", { recovery_code: enabled.recovery_codes[1] }, headers);
}

async function verifySalesMapSocket(ticket) {
  const socketUrl = `${base.replace(/^http/, "ws")}/ws/map?ticket=${encodeURIComponent(ticket)}`;
  const message = await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket did not acknowledge ${socketUrl}`));
    }, 5_000);

    socket.once("message", (payload) => {
      clearTimeout(timeout);
      socket.close();
      resolve(String(payload));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const event = JSON.parse(message);
  if (event.type !== "connected" || event.channel !== "sales-map") {
    throw new Error(`Unexpected sales-map WebSocket acknowledgement: ${message}`);
  }
}

  await request("GET", "/ready");
await request("GET", "/live");
const runtimeMetrics = await request("GET", "/metrics", undefined, {
  "x-internal-api-key": process.env.AUTH_INTERNAL_API_KEY ?? "dev-internal-auth-key"
});
if (runtimeMetrics.process?.rssBytes <= 0 || runtimeMetrics.dbPool?.maxConnections <= 0) {
  throw new Error("Runtime metrics contract failed");
}
await verifyAdvancedAuth();
await verifySalesMapSocket(await issueAnalyticsTicket());
const publications = await request("GET", "/catalog/publications");
if (!Array.isArray(publications) || !publications[0]) throw new Error("Catalog seed missing");

const cart = await request("POST", "/cart/sessions", {});
if (!cart.cart_access_token) throw new Error("Cart capability missing");
const cartHeaders = { "x-cart-access-token": cart.cart_access_token };
await expectStatus("GET", `/cart/sessions/${cart.id}`, 403);
const cartWithItem = await request("POST", `/cart/sessions/${cart.id}/items/predesigned`, {
  publication_slug: publications[0].slug,
  publication_id: publications[0].id,
  garment_type: "tshirt",
  garment_model: "oversize",
  color: "Negra",
  size: "M",
  grammage_g: 240,
  fit: "",
  quantity: 1,
  unit_price_mxn: 1
}, cartHeaders);
if (Number(cartWithItem.items[0]?.unit_price_mxn) !== Number(publications[0].price_mxn)) {
  throw new Error("Server accepted a client-controlled product price");
}
const checkout = await request("POST", "/checkout/sessions", {
  cart_id: cart.id,
  email: "e2e@saut.local",
  phone: "8710000000",
  address: { line1: "Av. Juárez 100", city: "Torreon", state: "Coahuila", postal_code: "27000", country: "MX" }
}, cartHeaders);
await expectStatus("GET", `/checkout/sessions/${checkout.id}`, 403);
const checkoutRead = await request("GET", `/checkout/sessions/${checkout.id}`, undefined, cartHeaders);
if (checkoutRead.email !== "e2e@saut.local") throw new Error("Checkout capability did not authorize its owner");
const attempt = await request("POST", "/payments/attempts", { checkout_session_id: checkout.id }, cartHeaders);
if (attempt.provider === "stripe" && !attempt.checkout_url) throw new Error("Hosted Stripe attempt is missing its checkout URL");
if ("client_secret" in attempt) throw new Error("Payment attempt exposed its client secret");
await expectStatus("GET", `/payments/attempts/${attempt.id}`, 403);
const confirmed = await request("POST", `/payments/attempts/${attempt.id}/confirm`, {}, cartHeaders);
if (!confirmed.order_id || !confirmed.order_access_token || confirmed.refunded_oversell) throw new Error("Payment/order flow failed");
await expectStatus("GET", `/orders/${confirmed.order_id}`, 403);
const initialOrder = await request("GET", `/orders/${confirmed.order_id}`, undefined, {
  "x-order-access-token": confirmed.order_access_token
});
if (initialOrder.id !== confirmed.order_id || initialOrder.items.length !== 1) throw new Error("Order contract failed");
const retry = await request("POST", `/payments/attempts/${attempt.id}/confirm`, {}, cartHeaders);
if (!retry.order_access_token || retry.order_id !== confirmed.order_id) throw new Error("Idempotent confirmation did not recover order access");
const order = await request("GET", `/orders/${confirmed.order_id}`, undefined, {
  "x-order-access-token": retry.order_access_token
});
if (order.id !== confirmed.order_id || order.items.length !== 1) throw new Error("Retried order contract failed");

const skydropxPayload = JSON.stringify({
  data: {
    id: "e2e-package",
    type: "packages",
    attributes: { status: "in_transit", tracking_number: "E2E-UNKNOWN", returned: false, returned_status: null },
    relationships: { shipment: { data: { id: "e2e-shipment" } } }
  }
});
const skydropxSignature = createHmac("sha512", skydropxSecret).update(skydropxPayload).digest("hex");
const skydropxWebhook = await fetch(`${base}/webhooks/shipping/skydropx`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `HMAC ${skydropxSignature}` },
  body: skydropxPayload
});
if (!skydropxWebhook.ok) throw new Error(`Skydropx webhook failed: ${skydropxWebhook.status} ${await skydropxWebhook.text()}`);
const skydropxResult = await skydropxWebhook.json();
if (!skydropxResult.received || skydropxResult.duplicate || skydropxResult.matched) throw new Error("Skydropx webhook contract failed");
const skydropxRetry = await fetch(`${base}/webhooks/shipping/skydropx`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `HMAC ${skydropxSignature}` },
  body: skydropxPayload
});
const skydropxRetryResult = await skydropxRetry.json();
if (!skydropxRetryResult.received || !skydropxRetryResult.duplicate) throw new Error("Skydropx webhook was not idempotent");
await expectStatus("PATCH", `/shipping/local/orders/${confirmed.order_id}/address`, 403, {
  address: { line1: "Calle sin autorización 1" }
});
const addressChange = await request("PATCH", `/shipping/local/orders/${confirmed.order_id}/address`, {
  address: { line1: "Av. Juárez 101", city: "Torreon", state: "Coahuila", postal_code: "27000", country: "MX" }
}, { "x-order-access-token": retry.order_access_token });
if (addressChange.address?.line1 !== "Av. Juárez 101") throw new Error("Authorized local address change failed");

if (process.env.ASSETS_INTERNAL_API_KEY) {
  const asset = await request("POST", "/assets/sign-upload", {
    content_type: "image/png",
    category: "support",
    visibility: "internal"
  }, { "x-internal-api-key": process.env.ASSETS_INTERNAL_API_KEY });
  await expectStatus("GET", `/assets/${asset.asset_id}/resolve`, 404);
}

console.log(`E2E completed: ${order.id}`);
