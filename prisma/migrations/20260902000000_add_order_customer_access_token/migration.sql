ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "customer_access_token_hash" text;

CREATE UNIQUE INDEX IF NOT EXISTS "orders_customer_access_token_hash_uq"
  ON "orders"("customer_access_token_hash")
  WHERE "customer_access_token_hash" IS NOT NULL;
