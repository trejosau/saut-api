import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { PrismaClient } from "../../generated/prisma/client.js";
import { config } from "../config.js";

const { Pool } = pg;

export type QueryResult<Row = any> = {
  rows: Row[];
  rowCount: number | null;
};

export type DatabasePoolMetrics = {
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
  maxConnections: number;
};

export type Queryable = {
  query<Row = any>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
};

type PrismaDataSourceDependencies = {
  pool?: pg.Pool;
  client?: PrismaClient;
};

export class PrismaDataSource implements Queryable {
  private readonly pool: pg.Pool;
  private readonly maxConnections: number;
  readonly client: PrismaClient;

  constructor(connectionString = config.DATABASE_URL, dependencies: PrismaDataSourceDependencies = {}) {
    this.maxConnections = config.NODE_ENV === "production" ? 20 : 10;
    this.pool = dependencies.pool ?? new Pool({
      connectionString,
      max: this.maxConnections,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
    this.client = dependencies.client ?? new PrismaClient({ adapter: new PrismaPg(this.pool) });
  }

  async query<Row = any>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    const normalized = sql.trim().toLowerCase();
    const returnsRows = normalized.startsWith("select") || normalized.startsWith("with") || /\breturning\b/.test(normalized);
    if (returnsRows) {
      const rows = await this.client.$queryRawUnsafe<Row[]>(sql, ...values);
      return { rows, rowCount: rows.length };
    }

    const rowCount = await this.client.$executeRawUnsafe(sql, ...values);
    return { rows: [], rowCount };
  }

  /**
   * Compatibility boundary for existing multi-step transactions. New data
   * access should prefer Prisma Client or `$transaction` through `client`.
   */
  connect(): Promise<pg.PoolClient> {
    return this.pool.connect();
  }

  poolMetrics(): DatabasePoolMetrics {
    return {
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      maxConnections: this.maxConnections,
    };
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`select 1`;
  }

  async close(): Promise<void> {
    await this.client.$disconnect();
    await this.pool.end();
  }
}

export const database = new PrismaDataSource();
export const prisma = database.client;
