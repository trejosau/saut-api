import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const domainTables = [
  "accounts", "account_identities", "login_challenges", "sessions", "auth_events", "mfa_policy", "account_mfa", "recovery_codes", "roles", "permissions",
  "role_permissions", "account_roles", "account_permission_overrides", "audit_log", "designs", "design_variants",
  "informative_images", "publications", "publication_mockups", "collections_sets", "collection_set_items", "drops",
  "drop_items", "season_config", "carts", "cart_items", "checkout_sessions", "payment_attempts",
  "payment_transactions", "refunds", "webhook_events", "orders", "order_items", "order_state_history", "drop_counters", "work_orders",
  "work_order_failures", "inventory_items", "inventory_movements", "stock_entries", "shipments", "shipment_events",
  "local_address_changes", "local_delivery_evidences", "support_cases", "support_case_messages",
  "support_case_attachments", "support_case_order_links", "notification_deliveries", "analytics_events", "sales_pings",
  "sku_pricing_rules", "customizer_pricing_configs", "assets"
] as const;

describe("consolidated schema", () => {
  it("contains the Prisma baseline and hardening migrations", async () => {
    const sql = await readFile(resolve(process.cwd(), "prisma/migrations/20260701000000_baseline/migration.sql"), "utf8");
    expect(domainTables).toHaveLength(54);
    const baseTables = domainTables.filter((table) => !["mfa_policy", "account_mfa", "recovery_codes", "webhook_events"].includes(table));
    for (const table of baseTables) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    const advancedAuthSql = await readFile(resolve(process.cwd(), "prisma/migrations/20260902050000_advanced_auth_core/migration.sql"), "utf8");
    for (const table of ["mfa_policy", "account_mfa", "recovery_codes"]) {
      expect(advancedAuthSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    const webhookSql = await readFile(resolve(process.cwd(), "prisma/migrations/20260902030000_add_webhook_integrity/migration.sql"), "utf8");
    expect(webhookSql).toContain('CREATE TABLE "webhook_events"');
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS migration_runs");
  });
});
