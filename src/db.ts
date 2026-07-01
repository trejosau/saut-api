import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.NODE_ENV === "production" ? 20 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

export const db = drizzle(pool);

export async function pingDatabase(): Promise<void> {
  await pool.query("select 1");
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export type Queryable = pg.Pool | pg.PoolClient;
