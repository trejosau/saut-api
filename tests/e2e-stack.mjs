/* global process, fetch, console */

const base = process.env.API_BASE_URL ?? "http://localhost:8080";

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
}

await request("GET", "/ready");
const publications = await request("GET", "/catalog/publications");
if (!Array.isArray(publications) || !publications[0]) throw new Error("Catalog seed missing");

const cart = await request("POST", "/cart/sessions", {});
await request("POST", `/cart/sessions/${cart.id}/items/predesigned`, {
  publication_slug: publications[0].slug,
  publication_id: publications[0].id,
  garment_type: "tshirt",
  garment_model: "oversize",
  color: "Negra",
  size: "M",
  grammage_g: 240,
  fit: "",
  quantity: 1
});
const checkout = await request("POST", "/checkout/sessions", {
  cart_id: cart.id,
  email: "e2e@saut.local",
  phone: "8710000000",
  address: { line1: "Av. Juárez 100", city: "Torreon", state: "Coahuila", postal_code: "27000", country: "MX" }
});
const attempt = await request("POST", "/payments/attempts", { checkout_session_id: checkout.id });
const confirmed = await request("POST", `/payments/attempts/${attempt.id}/confirm`, {});
if (!confirmed.order_id || confirmed.refunded_oversell) throw new Error("Payment/order flow failed");
const order = await request("GET", `/orders/${confirmed.order_id}`);
if (order.id !== confirmed.order_id || order.items.length !== 1) throw new Error("Order contract failed");

console.log(`E2E completed: ${order.id}`);
