import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { database } = vi.hoisted(() => ({
  database: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../src/db.js", () => ({
  database,
  closeDatabase: vi.fn(),
  pingDatabase: vi.fn(),
}));

import { config } from "../src/config.js";
import { registerSupportAnalytics } from "../src/modules/support-analytics.js";

const caseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const transactionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    reply.status(Number((error as { statusCode?: number }).statusCode ?? 500)).send({
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: transactionId,
    amount_mxn: 500,
    refunded_amount_mxn: 0,
    provider_charge_id: "ch_test_123",
    ...overrides,
  };
}

async function refundRoute(options: {
  transaction?: Record<string, unknown>;
  stripe?: Record<string, unknown>;
} = {}) {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    release: vi.fn(),
  };
  client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  client.query.mockResolvedValueOnce({ rows: [transaction(options.transaction)], rowCount: 1 });
  database.connect.mockResolvedValue(client);
  database.query.mockResolvedValue({ rows: [], rowCount: 1 });
  database.query.mockResolvedValueOnce({ rows: [{ id: caseId, linked_order_id: orderId }], rowCount: 1 });

  const app = Fastify({ logger: false });
  errorHandler(app);
  await registerSupportAnalytics(app, {
    database: database as never,
    redis: {} as never,
    s3: {} as never,
    stripe: {
      refunds: {
        create: vi.fn().mockResolvedValue({ id: "re_test_123" }),
      },
      ...options.stripe,
    } as never,
    sockets: new Set(),
  });
  return { app, client };
}

describe("support refunds", () => {
  const originalStripeMode = config.STRIPE_MODE;

  beforeEach(() => {
    database.query.mockReset();
    database.connect.mockReset();
    config.STRIPE_MODE = "mock";
  });

  afterEach(() => {
    config.STRIPE_MODE = originalStripeMode;
  });

  it("records a valid integer automatic refund while locking the transaction row", async () => {
    const { app, client } = await refundRoute();

    const response = await app.inject({
      method: "POST",
      url: `/admin/support/cases/${caseId}/refunds`,
      payload: { mode: "auto", reason_code: "damaged", amount_mxn: 100 },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ auto_allowed: true, recorded: true });
    expect(String(client.query.mock.calls[1]?.[0]).toLowerCase()).toContain("for update");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("update payment_transactions set refunded_amount_mxn=refunded_amount_mxn+$2"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("insert into refunds"))).toBe(true);
  });

  it.each([-1, 0, 100.5])("rejects a non-positive or non-integer refund amount: %s", async (amount) => {
    const { app, client } = await refundRoute();

    const response = await app.inject({
      method: "POST",
      url: `/admin/support/cases/${caseId}/refunds`,
      payload: { mode: "auto", reason_code: "damaged", amount_mxn: amount },
    });
    await app.close();

    expect(response.statusCode).toBe(422);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("insert into refunds"))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("update payment_transactions set refunded_amount_mxn=refunded_amount_mxn+$2"))).toBe(false);
  });

  it("rejects a refund when the transaction has no refundable balance", async () => {
    const { app } = await refundRoute({ transaction: { refunded_amount_mxn: 500 } });

    const response = await app.inject({
      method: "POST",
      url: `/admin/support/cases/${caseId}/refunds`,
      payload: { mode: "auto", reason_code: "damaged", amount_mxn: 100 },
    });
    await app.close();

    expect(response.statusCode).toBe(409);
  });

  it("compensates the ledger when Stripe rejects an automatic refund", async () => {
    config.STRIPE_MODE = "live";
    const stripeError = new Error("Stripe unavailable");
    const stripe = { refunds: { create: vi.fn().mockRejectedValue(stripeError) } };
    const { app } = await refundRoute({ stripe });

    const response = await app.inject({
      method: "POST",
      url: `/admin/support/cases/${caseId}/refunds`,
      payload: { mode: "auto", reason_code: "damaged", amount_mxn: 100 },
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "ch_test_123", amount: 10_000 }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("update refunds set status='failed'"))).toBe(true);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("update payment_transactions set refunded_amount_mxn=refunded_amount_mxn-$2"))).toBe(true);
  });

  it("rejects automatic refunds in live mode when the charge id is missing", async () => {
    config.STRIPE_MODE = "live";
    const stripe = { refunds: { create: vi.fn() } };
    const { app, client } = await refundRoute({ transaction: { provider_charge_id: null }, stripe });

    const response = await app.inject({
      method: "POST",
      url: `/admin/support/cases/${caseId}/refunds`,
      payload: { mode: "auto", reason_code: "damaged", amount_mxn: 100 },
    });
    await app.close();

    expect(response.statusCode).toBe(422);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("insert into refunds"))).toBe(false);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("update refunds set status='succeeded'"))).toBe(false);
  });
});
