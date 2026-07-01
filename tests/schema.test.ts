import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const domainTables = [
  "accounts", "account_identities", "login_challenges", "sessions", "auth_events", "roles", "permissions",
  "role_permissions", "account_roles", "account_permission_overrides", "audit_log", "designs", "design_variants",
  "informative_images", "publications", "publication_mockups", "collections_sets", "collection_set_items", "drops",
  "drop_items", "season_config", "carts", "cart_items", "checkout_sessions", "payment_attempts",
  "payment_transactions", "refunds", "orders", "order_items", "order_state_history", "drop_counters", "work_orders",
  "work_order_failures", "inventory_items", "inventory_movements", "stock_entries", "shipments", "shipment_events",
  "local_address_changes", "local_delivery_evidences", "support_cases", "support_case_messages",
  "support_case_attachments", "support_case_order_links", "notification_deliveries", "analytics_events", "sales_pings",
  "sku_pricing_rules", "customizer_pricing_configs", "assets"
] as const;

describe("consolidated schema", () => {
  it("contains all 49 migrated tables plus persistent assets", async () => {
    const sql = await readFile(resolve(process.cwd(), "migrations/0001_consolidated_schema.sql"), "utf8");
    expect(domainTables).toHaveLength(50);
    for (const table of domainTables) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS migration_runs");
  });
});
