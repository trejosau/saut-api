import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

import pg from "pg";

import { config } from "./config.js";

const { Client } = pg;
const TARGET_DATABASE = new URL(config.DATABASE_URL).pathname.slice(1) || "saut";
const LEGACY_DATABASES = [
  "saut_auth_db",
  "saut_catalog_db",
  "saut_notification_db",
  "saut_cart_checkout_db",
  "saut_payments_db",
  "saut_orders_db",
  "saut_inventory_db",
  "saut_production_work_orders_db",
  "saut_shipping_db",
  "saut_support_db",
  "saut_analytics_map_db",
  "saut_permissions_audit_db",
  "saut_pricing_db"
] as const;

const TABLE_ORDER = [
  "accounts", "roles", "permissions", "account_identities", "login_challenges", "sessions",
  "auth_events", "audit_log", "role_permissions", "account_roles", "account_permission_overrides",
  "designs", "design_variants", "informative_images", "publications", "publication_mockups",
  "collections_sets", "collection_set_items", "drops", "drop_items", "season_config",
  "carts", "cart_items", "checkout_sessions", "payment_attempts", "payment_transactions", "refunds", "webhook_events",
  "orders", "order_items", "order_state_history", "drop_counters", "work_orders", "work_order_failures",
  "inventory_items", "inventory_movements", "stock_entries", "shipments", "shipment_events",
  "local_address_changes", "local_delivery_evidences", "support_cases", "support_case_messages",
  "support_case_attachments", "support_case_order_links", "notification_deliveries", "analytics_events",
  "sales_pings", "sku_pricing_rules", "customizer_pricing_configs", "assets"
] as const;

function databaseUrl(name: string): string {
  const url = new URL(config.POSTGRES_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function ensureTargetDatabase(admin: pg.Client): Promise<void> {
  const exists = await admin.query<{ exists: boolean }>(
    "select exists(select 1 from pg_database where datname = $1) as exists",
    [TARGET_DATABASE]
  );
  if (!exists.rows[0]?.exists) {
    await admin.query(`create database ${quoteIdentifier(TARGET_DATABASE)}`);
  }
}

async function applySqlDirectory(client: pg.Client, directory: string): Promise<void> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(resolve(directory, file), "utf8");
    await client.query(sql);
  }
}

async function backupDatabase(name: string): Promise<string> {
  await mkdir(config.MIGRATION_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const output = resolve(config.MIGRATION_BACKUP_DIR, `${name}-${stamp}.dump`);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("pg_dump", ["--format=custom", "--file", output, databaseUrl(name)], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`pg_dump ${name} exited ${code}`)));
    });
  } catch (error) {
    await unlink(output).catch(() => undefined);
    throw error;
  }
  return output;
}

async function tableNames(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
      and table_name not in ('seaql_migrations', '_seaql_migrations', '__drizzle_migrations', 'migration_runs')
  `);
  return result.rows.map((row) => row.table_name);
}

async function columns(client: pg.Client, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = $1 order by ordinal_position
  `, [table]);
  return result.rows.map((row) => row.column_name);
}

async function jsonColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = $1 and data_type in ('json', 'jsonb')
  `, [table]);
  return new Set(result.rows.map((row) => row.column_name));
}

async function primaryKey(client: pg.Client, table: string): Promise<string | null> {
  const result = await client.query<{ column_name: string }>(`
    select kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY'
    order by kcu.ordinal_position limit 1
  `, [table]);
  return result.rows[0]?.column_name ?? null;
}

async function copyTable(source: pg.Client, target: pg.Client, table: string): Promise<{ source: number; target: number }> {
  const [sourceColumns, targetColumns, targetJsonColumns] = await Promise.all([columns(source, table), columns(target, table), jsonColumns(target, table)]);
  const common = sourceColumns.filter((column) => targetColumns.includes(column));
  if (common.length === 0) return { source: 0, target: 0 };

  const sourceCount = Number((await source.query(`select count(*)::bigint as count from ${quoteIdentifier(table)}`)).rows[0]?.count ?? 0);
  const batchSize = 250;
  const columnSql = common.map(quoteIdentifier).join(", ");
  for (let offset = 0; offset < sourceCount; offset += batchSize) {
    const rows = (await source.query(
      `select ${columnSql} from ${quoteIdentifier(table)} order by 1 limit $1 offset $2`,
      [batchSize, offset]
    )).rows;
    if (rows.length === 0) break;
    const values: unknown[] = [];
    const tuples = rows.map((row) => {
      const placeholders = common.map((column) => {
        const value = row[column];
        values.push(targetJsonColumns.has(column) && value !== null && typeof value === "object" ? JSON.stringify(value) : value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(",")})`;
    });
    await target.query(
      `insert into ${quoteIdentifier(table)} (${columnSql}) values ${tuples.join(",")} on conflict do nothing`,
      values
    );
  }

  const key = await primaryKey(source, table);
  if (key && targetColumns.includes(key)) {
    const missing = await source.query(`select ${quoteIdentifier(key)} from ${quoteIdentifier(table)}`);
    for (let offset = 0; offset < missing.rows.length; offset += 1000) {
      const ids = missing.rows.slice(offset, offset + 1000).map((row) => row[key]);
      if (ids.length === 0) continue;
      const found = await target.query(
        `select ${quoteIdentifier(key)} from ${quoteIdentifier(table)} where ${quoteIdentifier(key)} = any($1)`,
        [ids]
      );
      if (found.rowCount !== ids.length) {
        throw new Error(`Validation failed for ${table}: ${ids.length - (found.rowCount ?? 0)} primary keys missing`);
      }
    }
  }
  const targetCount = Number((await target.query(`select count(*)::bigint as count from ${quoteIdentifier(table)}`)).rows[0]?.count ?? 0);
  if (targetCount < sourceCount) throw new Error(`Validation failed for ${table}: ${targetCount} < ${sourceCount}`);
  return { source: sourceCount, target: targetCount };
}

async function importLegacyDatabase(name: string, target: pg.Client): Promise<Record<string, unknown>> {
  const source = new Client({ connectionString: databaseUrl(name) });
  try {
    await source.connect();
    const available = await tableNames(source);
    const targetAvailable = new Set(await tableNames(target));
    const report: Record<string, unknown> = {};
    for (const table of TABLE_ORDER) {
      if (available.includes(table) && targetAvailable.has(table)) {
        report[table] = await copyTable(source, target, table);
      }
    }
    report.archived_only_tables = available.filter((table) => !targetAvailable.has(table));
    return report;
  } finally {
    await source.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const admin = new Client({ connectionString: config.POSTGRES_ADMIN_URL });
  try {
    await admin.connect();
    await ensureTargetDatabase(admin);
    const existing = config.MIGRATION_IMPORT_LEGACY_DATABASES
      ? (await admin.query<{ datname: string }>(
          "select datname from pg_database where datname = any($1::text[])",
          [LEGACY_DATABASES]
        )).rows.map((row) => row.datname)
      : [];
    const target = new Client({ connectionString: databaseUrl(TARGET_DATABASE) });
    try {
      await target.connect();
      const root = process.cwd();
      const migrations = resolve(root, "migrations");
      const seeds = resolve(root, "seeds");
      await applySqlDirectory(target, migrations);

      if (config.MIGRATION_IMPORT_LEGACY_DATABASES) {
        const prior = await target.query<{ status: string }>(
          "select status from migration_runs where migration_key = 'legacy-consolidation-v1'"
        );
        if (prior.rows[0]?.status !== "completed" && existing.length > 0) {
        await target.query(`
          insert into migration_runs (migration_key, status, details)
          values ('legacy-consolidation-v1', 'running', '{}'::jsonb)
          on conflict (migration_key) do update set status = 'running', started_at = now(), completed_at = null
        `);
        const details: Record<string, unknown> = { databases: {} };
        for (const database of existing) {
          const backup = await backupDatabase(database);
          const report = await importLegacyDatabase(database, target);
          (details.databases as Record<string, unknown>)[database] = { backup: basename(backup), report };
        }
        if (config.MIGRATION_DROP_LEGACY_DATABASES) {
          for (const database of existing) {
            await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
            await admin.query(`drop database ${quoteIdentifier(database)}`);
          }
        }
        await target.query(
          "update migration_runs set status = 'completed', details = $1, completed_at = now() where migration_key = 'legacy-consolidation-v1'",
          [details]
        );
        } else if (prior.rows[0]?.status !== "completed") {
          await target.query(`
            insert into migration_runs (migration_key, status, details, completed_at)
            values ('legacy-consolidation-v1', 'completed', '{"fresh_install":true}'::jsonb, now())
            on conflict (migration_key) do update set status = 'completed', details = excluded.details, completed_at = now()
          `);
        }
      }

      await applySqlDirectory(target, seeds);
      console.log(`Bootstrap completed for ${TARGET_DATABASE}`);
    } finally {
      await target.end().catch(() => undefined);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
