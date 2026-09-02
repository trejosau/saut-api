ALTER TABLE carts
  ADD COLUMN IF NOT EXISTS cart_access_token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS carts_access_token_hash_uq
  ON carts (cart_access_token_hash)
  WHERE cart_access_token_hash IS NOT NULL;
