import type pg from "pg";
import { vi } from "vitest";

import type { PrismaDataSource, QueryResult } from "../../src/database/prisma-data-source.js";
import type { AppContext } from "../../src/types.js";

export function result(rows: Record<string, unknown>[] = [], rowCount = rows.length): QueryResult<Record<string, unknown>> {
  return { rows, rowCount };
}

export function createRouteTestContext() {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<QueryResult<Record<string, unknown>>>>();
  const transactionQuery = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<QueryResult<Record<string, unknown>>>>();
  const release = vi.fn();
  const transactionClient = { query: transactionQuery, release } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => transactionClient);
  const database = { query, connect } as unknown as PrismaDataSource;
  const redis = {
    status: "ready",
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ping: vi.fn(async () => "PONG"),
  };
  const s3 = { send: vi.fn() };
  const stripe = {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
    refunds: { create: vi.fn() },
  };

  const context = {
    database,
    redis,
    s3,
    stripe,
    sockets: new Set(),
  } as unknown as AppContext;

  return { context, query, connect, transactionQuery, release, redis, s3, stripe };
}
