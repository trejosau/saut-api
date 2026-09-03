import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { verifySkydropxWebhook, verifyStripeWebhook, validateSkydropxPayload } from "../src/modules/webhooks.js";
import type { AppContext } from "../src/types.js";

function stripeContext(constructEvent: AppContext["stripe"]["webhooks"]["constructEvent"]): AppContext {
  return { stripe: { webhooks: { constructEvent } } } as unknown as AppContext;
}

describe("webhook provider contracts", () => {
  it("verifies Stripe's signed raw body and rejects an expired timestamp", () => {
    const rawBody = JSON.stringify({ id: "evt_test_123", type: "checkout.session.completed", data: { object: {} } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", config.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
    const constructEvent = ((payload: string | Buffer, header: string, secret: string, tolerance?: number) => {
      const [timestampPart, signaturePart] = String(header).split(",");
      const receivedTimestamp = Number(String(timestampPart).replace("t=", ""));
      if (secret !== config.STRIPE_WEBHOOK_SECRET || Math.abs(Date.now() / 1000 - receivedTimestamp) > Number(tolerance)) throw new Error("invalid");
      const receivedSignature = String(signaturePart).replace("v1=", "");
      const expected = createHmac("sha256", secret).update(`${receivedTimestamp}.${String(payload)}`).digest("hex");
      if (receivedSignature !== expected) throw new Error("invalid");
      return JSON.parse(String(payload));
    }) as unknown as AppContext["stripe"]["webhooks"]["constructEvent"];

    expect(verifyStripeWebhook(stripeContext(constructEvent), rawBody, `t=${timestamp},v1=${signature}`).id).toBe("evt_test_123");
    expect(() => verifyStripeWebhook(stripeContext(constructEvent), rawBody, `t=${timestamp - 301},v1=${signature}`)).toThrow("inválida o expirada");
  });

  it("verifies only Skydropx's documented HMAC or bearer schemes", () => {
    const rawBody = '{"data":{"id":"package-1"}}';
    const signature = createHmac("sha512", config.SKYDROPX_WEBHOOK_SECRET).update(rawBody).digest("hex");
    expect(() => verifySkydropxWebhook(rawBody, `HMAC ${signature}`)).not.toThrow();
    expect(() => verifySkydropxWebhook(rawBody, `Bearer ${config.SKYDROPX_WEBHOOK_SECRET}`)).not.toThrow();
    expect(() => verifySkydropxWebhook(rawBody, `X-Signature ${signature}`)).toThrow("Autenticación Skydropx inválida");
    expect(() => verifySkydropxWebhook(`${rawBody} `, `HMAC ${signature}`)).toThrow("Firma Skydropx inválida");
  });

  it("validates the documented Skydropx shipment payload shape", () => {
    expect(validateSkydropxPayload({
      data: {
        id: "6172eb82-7b0b-4852-9954-b1ac1c20e4f8",
        type: "packages",
        attributes: {
          status: "delivered",
          tracking_number: "794874381730",
          tracking_url_provider: "https://carrier.example/track/794874381730",
          label_url: "https://api.example/label.pdf",
          returned: false,
          returned_status: null,
        },
        relationships: { shipment: { data: { id: "93774c22-8275-4757-9963-71b79b2e8db7" } } },
      },
    }).data.attributes.status).toBe("delivered");
    expect(() => validateSkydropxPayload({ data: { id: "package-1", type: "packages", attributes: {} } })).toThrow("Payload Skydropx inválido");
  });
});
