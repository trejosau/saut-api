import { createHmac, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";

import { config } from "../config.js";
import { confirmPaymentAttemptInTransaction, processOversellRefund } from "./commerce.js";
import { asObject, HttpError, secureEqual, sha256 } from "../platform.js";
import type { AppContext } from "../types.js";

const stripeEventSchema = z.object({
  id: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(255),
  data: z.object({ object: z.record(z.string(), z.unknown()) }).passthrough(),
}).passthrough();

const checkoutSessionSchema = z.object({
  id: z.string().trim().min(1).max(255),
  metadata: z.object({ checkout_session_id: z.string().uuid() }).passthrough().nullable().optional(),
  payment_intent: z.union([
    z.string().trim().min(1).max(255),
    z.object({ id: z.string().trim().min(1).max(255) }).passthrough(),
  ]).nullable().optional(),
  amount_total: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  payment_status: z.string().trim().min(1).max(64).optional(),
}).passthrough();

const skydropxEventSchema = z.object({
  data: z.object({
    id: z.string().trim().min(1).max(255),
    type: z.string().trim().min(1).max(64),
    attributes: z.object({
      status: z.string().trim().min(1).max(64),
      tracking_number: z.string().trim().min(1).max(255).nullable().optional(),
      tracking_url_provider: z.string().url().or(z.literal("")).nullable().optional(),
      label_url: z.string().url().or(z.literal("")).nullable().optional(),
      returned: z.boolean().optional(),
      returned_status: z.string().trim().min(1).max(64).nullable().optional(),
    }).passthrough(),
    relationships: z.object({
      shipment: z.object({ data: z.object({ id: z.string().trim().min(1).max(255) }).passthrough() }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

type WebhookIdentity = {
  provider: "stripe" | "skydropx";
  eventId: string;
  eventIdSource: "provider" | "payload_hash";
  eventType: string;
  payloadSha256: string;
  payload: Record<string, unknown>;
};

export function verifyStripeWebhook(context: AppContext, rawBody: string, signature: string | undefined): Record<string, any> {
  if (!signature) throw new HttpError(400, "Firma Stripe ausente", undefined, "WEBHOOK_SIGNATURE_INVALID");
  try {
    return stripeEventSchema.parse(context.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.STRIPE_WEBHOOK_SECRET,
      config.STRIPE_WEBHOOK_TOLERANCE_SEC,
    ));
  } catch {
    throw new HttpError(400, "Firma Stripe inválida o expirada", undefined, "WEBHOOK_SIGNATURE_INVALID");
  }
}

export function verifySkydropxWebhook(rawBody: string, authorization: string | undefined): void {
  if (!authorization) throw new HttpError(401, "Autenticación Skydropx ausente", undefined, "WEBHOOK_AUTH_INVALID");
  const [scheme, credential] = authorization.trim().split(/\s+/, 2);
  if (!scheme || !credential) throw new HttpError(401, "Autenticación Skydropx inválida", undefined, "WEBHOOK_AUTH_INVALID");

  if (scheme.toLowerCase() === "hmac") {
    const expected = createHmac("sha512", config.SKYDROPX_WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
    if (!/^[0-9a-f]{128}$/i.test(credential) || !secureEqual(credential.toLowerCase(), expected)) {
      throw new HttpError(401, "Firma Skydropx inválida", undefined, "WEBHOOK_SIGNATURE_INVALID");
    }
    return;
  }

  if (scheme.toLowerCase() === "bearer" && secureEqual(credential, config.SKYDROPX_WEBHOOK_SECRET)) return;
  throw new HttpError(401, "Autenticación Skydropx inválida", undefined, "WEBHOOK_AUTH_INVALID");
}

export function validateSkydropxPayload(payload: unknown): Record<string, any> {
  try {
    return skydropxEventSchema.parse(payload) as Record<string, any>;
  } catch {
    throw new HttpError(422, "Payload Skydropx inválido", undefined, "WEBHOOK_PAYLOAD_INVALID");
  }
}

async function recordWebhookFailure(context: AppContext, identity: WebhookIdentity, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 1000) : "Error de procesamiento";
  await context.database.query(`
    insert into webhook_events(id,provider,event_id,event_id_source,event_type,payload,payload_sha256,status,attempts,last_error,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,'failed',1,$8,now())
    on conflict(provider,event_id) do update set status='failed', attempts=webhook_events.attempts+1,
      last_error=excluded.last_error, updated_at=now()
  `, [randomUUID(), identity.provider, identity.eventId, identity.eventIdSource, identity.eventType, identity.payload, identity.payloadSha256, message]).catch(() => undefined);
}

async function deliverOnce<T>(
  context: AppContext,
  identity: WebhookIdentity,
  handler: (client: pg.PoolClient) => Promise<T>,
): Promise<{ duplicate: boolean; value: T | null }> {
  const client = await context.database.connect();
  let claimed = false;
  try {
    await client.query("begin");
    const inserted = await client.query(`
      insert into webhook_events(id,provider,event_id,event_id_source,event_type,payload,payload_sha256,status,attempts)
      values($1,$2,$3,$4,$5,$6,$7,'processing',1)
      on conflict(provider,event_id) do nothing
      returning id
    `, [randomUUID(), identity.provider, identity.eventId, identity.eventIdSource, identity.eventType, identity.payload, identity.payloadSha256]);

    if (!inserted.rows[0]) {
      const existing = (await client.query(
        "select status,payload_sha256 from webhook_events where provider=$1 and event_id=$2 for update",
        [identity.provider, identity.eventId],
      )).rows[0];
      if (!existing) throw new HttpError(503, "No se pudo reclamar el webhook", undefined, "WEBHOOK_RETRY");
      if (existing.payload_sha256 !== identity.payloadSha256) {
        throw new HttpError(409, "El event ID ya fue recibido con otro payload", undefined, "WEBHOOK_EVENT_CONFLICT");
      }
      if (existing.status === "processed" || existing.status === "processing") {
        await client.query("commit");
        return { duplicate: true, value: null };
      }
      await client.query("update webhook_events set status='processing',attempts=attempts+1,last_error=null,updated_at=now() where provider=$1 and event_id=$2", [identity.provider, identity.eventId]);
    }
    claimed = true;
    const value = await handler(client);
    await client.query("update webhook_events set status='processed',processed_at=now(),last_error=null,updated_at=now() where provider=$1 and event_id=$2", [identity.provider, identity.eventId]);
    await client.query("commit");
    return { duplicate: false, value };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (claimed) await recordWebhookFailure(context, identity, error);
    throw error;
  } finally {
    client.release();
  }
}

function stripePaymentIntentId(session: Record<string, any>): string | null {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === "string") return paymentIntent;
  return asObject(paymentIntent).id ? String(asObject(paymentIntent).id) : null;
}

async function processStripeEvent(context: AppContext, client: pg.PoolClient, event: Record<string, any>): Promise<Record<string, unknown>> {
  if (!new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]).has(event.type)) {
    return { handled: false, matched: false };
  }

  const session = checkoutSessionSchema.parse(event.data.object);
  if (event.type === "checkout.session.completed" && session.payment_status !== "paid") {
    return { handled: true, matched: false, pending: true };
  }
  const checkoutId = session.metadata?.checkout_session_id ?? null;
  const attempt = (await client.query(
    "select * from payment_attempts where provider='stripe' and (provider_payment_intent_id=$1 or checkout_session_id=$2) limit 1 for update",
    [session.id, checkoutId],
  )).rows[0];
  if (!attempt) return { handled: true, matched: false };
  if (session.amount_total === null || session.amount_total === undefined || session.amount_total !== Number(attempt.amount_mxn) * 100) {
    throw new HttpError(409, "El monto Stripe no coincide con el intento de pago", undefined, "WEBHOOK_PAYMENT_MISMATCH");
  }
  if (session.currency && session.currency.toLowerCase() !== String(attempt.currency).toLowerCase()) {
    throw new HttpError(409, "La moneda Stripe no coincide con el intento de pago", undefined, "WEBHOOK_PAYMENT_MISMATCH");
  }
  const result = await confirmPaymentAttemptInTransaction(context, client, attempt.id, { paymentIntentId: stripePaymentIntentId(session), rotateOrderAccessToken: false });
  return {
    handled: true,
    matched: true,
    order_id: result.order_id,
    refunded_oversell: result.refunded_oversell,
    refund_operation_id: result.refund_operation_id,
  };
}

async function processSkydropxEvent(client: pg.PoolClient, payload: Record<string, any>): Promise<Record<string, unknown>> {
  const data = payload.data;
  const attributes = data.attributes;
  const providerShipmentId = data.relationships?.shipment?.data?.id ?? data.id;
  const shipment = (await client.query(
    "select * from shipments where provider_shipment_id=$1 or tracking_number=$2 limit 1 for update",
    [providerShipmentId, attributes.tracking_number ?? null],
  )).rows[0];
  if (!shipment) return { matched: false };

  await client.query(`
    update shipments
    set status=$2,
        tracking_url=coalesce($3,tracking_url),
        label_url=coalesce($4,label_url),
        updated_at=now()
    where id=$1
  `, [shipment.id, attributes.status, attributes.tracking_url_provider ?? null, attributes.label_url ?? null]);
  await client.query(
    "insert into shipment_events(id,shipment_id,event_type,payload) values($1,$2,'skydropx_webhook',$3)",
    [randomUUID(), shipment.id, payload],
  );
  return { matched: true, shipment_id: shipment.id };
}

export async function registerWebhooks(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/webhooks/payments/stripe", async (request) => {
    const rawBody = request.rawBody;
    if (typeof rawBody !== "string") throw new HttpError(400, "Se requiere el body crudo del webhook", undefined, "WEBHOOK_PAYLOAD_INVALID");
    const event = verifyStripeWebhook(context, rawBody, request.headers["stripe-signature"] as string | undefined);
    const identity: WebhookIdentity = {
      provider: "stripe",
      eventId: event.id,
      eventIdSource: "provider",
      eventType: event.type,
      payloadSha256: sha256(rawBody),
      payload: event,
    };
    const result = await deliverOnce(context, identity, (client) => processStripeEvent(context, client, event));
    const refundOperationId = result.value?.refund_operation_id;
    if (typeof refundOperationId === "string") await processOversellRefund(context, refundOperationId);
    return { received: true, duplicate: result.duplicate, ...(result.value ?? {}) };
  });

  app.post("/webhooks/shipping/skydropx", async (request) => {
    const rawBody = request.rawBody;
    if (typeof rawBody !== "string") throw new HttpError(400, "Se requiere el body crudo del webhook", undefined, "WEBHOOK_PAYLOAD_INVALID");
    const configuredHeader = config.SKYDROPX_WEBHOOK_AUTH_HEADER.toLowerCase();
    const header = request.headers[configuredHeader];
    const authorization = Array.isArray(header) ? header[0] : header;
    verifySkydropxWebhook(rawBody, authorization);
    const payload = validateSkydropxPayload(request.body);
    const identity: WebhookIdentity = {
      provider: "skydropx",
      eventId: sha256(rawBody),
      eventIdSource: "payload_hash",
      eventType: `skydropx.${payload.data.type}.${payload.data.attributes.status}`,
      payloadSha256: sha256(rawBody),
      payload,
    };
    const result = await deliverOnce(context, identity, (client) => processSkydropxEvent(client, payload));
    return { received: true, duplicate: result.duplicate, ...(result.value ?? {}) };
  });
}
