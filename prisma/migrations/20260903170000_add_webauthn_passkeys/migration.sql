CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text,
  backed_up boolean NOT NULL DEFAULT false,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_account_idx
  ON webauthn_credentials(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('registration', 'authentication')),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webauthn_challenges_account_type_check
    CHECK ((type = 'registration' AND account_id IS NOT NULL) OR (type = 'authentication' AND account_id IS NULL))
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_account_idx
  ON webauthn_challenges(account_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx
  ON webauthn_challenges(type, expires_at);
