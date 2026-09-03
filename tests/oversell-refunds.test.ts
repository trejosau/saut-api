import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { confirmPaymentAttemptInTransaction, processOversellRefund } from "../src/modules/commerce.js";

const refundId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const attemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const transactionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const operation = {
  id: refundId,
  payment_attempt_id: attemptId,
  payment_transaction_id: transactionId,
  amount_mxn: 250,
  provider_charge_id: "pi_oversell_123",
};

function makeContext() {
  let claimable = true;
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const database = {
    connect: vi.fn().mockImplementation(async () => ({
      query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params });
        if (sql.includes("select r.id")) {
          if (!claimable) return { rows: [], rowCount: 0 };
          claimable = false;
          return { rows: [operation], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    })),
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
  const stripe = { refunds: { create: vi.fn() } };
  return { context: { database, stripe } as never, database, stripe, executed, allowRetry: () => { claimable = true; } };
}

describe("durable Stripe oversell refunds", () => {
  const originalStripeMode = config.STRIPE_MODE;

  beforeEach(() => {
    config.STRIPE_MODE = "live";
  });

  afterEach(() => {
    config.STRIPE_MODE = originalStripeMode;
  });

  it("confirms a successful refund and records the provider identity", async () => {
    const { context, stripe, executed } = makeContext();
    stripe.refunds.create.mockResolvedValue({ id: "re_123" });

    await expect(processOversellRefund(context, refundId)).resolves.toBe("succeeded");

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: operation.provider_charge_id, amount: 25_000, reason: "requested_by_customer" },
      { idempotencyKey: `oversell-refund:${refundId}` },
    );
    expect(executed).toContainEqual({
      sql: expect.stringContaining("status=$2") as string,
      params: [refundId, "succeeded", "re_123"],
    });
  });

  it("persists an oversell operation before any provider call", async () => {
    const { context, stripe } = makeContext();
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          id: attemptId,
          checkout_session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          status: "pending",
          amount_mxn: 250,
          currency: "MXN",
          provider: "stripe",
          metadata: { reservations_released: true },
        }] })
        .mockResolvedValueOnce({ rows: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: attemptId, status: "refund_pending" }] }),
    };

    const result = await confirmPaymentAttemptInTransaction(
      context,
      client as never,
      attemptId,
      { paymentIntentId: operation.provider_charge_id },
    );

    expect(result.refunded_oversell).toBe(true);
    expect(result.refund_operation_id).toEqual(expect.any(String));
    expect(String(client.query.mock.calls[3]?.[0])).toContain("insert into refunds");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("records a definitive provider failure without claiming the refund succeeded", async () => {
    const { context, stripe, executed } = makeContext();
    stripe.refunds.create.mockRejectedValue({ type: "StripeInvalidRequestError", statusCode: 400 });

    await expect(processOversellRefund(context, refundId)).resolves.toBe("failed");

    expect(executed).toContainEqual({
      sql: expect.stringContaining("status=$2") as string,
      params: [refundId, "failed", null],
    });
    expect(executed).toContainEqual({
      sql: expect.stringContaining("status='refund_failed'") as string,
      params: [attemptId],
    });
    expect(executed.some(({ sql }) => sql.includes("status='succeeded'"))).toBe(false);
  });

  it("keeps a timeout outcome recoverable", async () => {
    const { context, stripe, executed } = makeContext();
    stripe.refunds.create.mockRejectedValue(new Error("socket closed before response"));

    await expect(processOversellRefund(context, refundId)).resolves.toBe("unknown");

    expect(executed).toContainEqual({
      sql: expect.stringContaining("status='unknown'") as string,
      params: [refundId],
    });
    expect(executed.some(({ sql }) => sql.includes("status='refunded'"))).toBe(false);
  });

  it("recovers when Stripe processed the refund but the first response was lost", async () => {
    const { context, stripe, allowRetry } = makeContext();
    stripe.refunds.create
      .mockRejectedValueOnce(new Error("response lost after provider commit"))
      .mockResolvedValueOnce({ id: "re_recovered" });

    await expect(processOversellRefund(context, refundId)).resolves.toBe("unknown");
    allowRetry();
    await expect(processOversellRefund(context, refundId)).resolves.toBe("succeeded");

    expect(stripe.refunds.create).toHaveBeenCalledTimes(2);
    const firstCall = stripe.refunds.create.mock.calls[0];
    const secondCall = stripe.refunds.create.mock.calls[1];
    expect(firstCall?.[1]).toEqual(secondCall?.[1]);
  });

  it("allows one concurrent claimant and skips the duplicate reconciliation", async () => {
    const { context, stripe } = makeContext();
    stripe.refunds.create.mockResolvedValue({ id: "re_once" });

    const results = await Promise.all([
      processOversellRefund(context, refundId),
      processOversellRefund(context, refundId),
    ]);

    expect(results.sort()).toEqual(["skipped", "succeeded"]);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });
});
