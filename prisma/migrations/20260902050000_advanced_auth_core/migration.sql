CREATE TABLE IF NOT EXISTS mfa_policy (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode text NOT NULL DEFAULT 'optional' CHECK (mode IN ('disabled', 'optional', 'required_all', 'required_roles')),
  required_roles text[] NOT NULL DEFAULT '{}',
  step_up_ttl_sec integer NOT NULL DEFAULT 300 CHECK (step_up_ttl_sec BETWEEN 60 AND 3600),
  updated_by_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mfa_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS account_mfa (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  pending_secret_encrypted text,
  secret_encrypted text,
  enabled boolean NOT NULL DEFAULT false,
  last_totp_step bigint,
  confirmed_at timestamptz,
  recovery_codes_generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_codes_active_hash_idx
  ON recovery_codes(account_id, code_hash) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS recovery_codes_account_idx ON recovery_codes(account_id, used_at);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS step_up_verified_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS step_up_method text;
