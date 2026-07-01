CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_key text NOT NULL UNIQUE,
  status text NOT NULL,
  details jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text NOT NULL DEFAULT 'customer',
  status text NOT NULL DEFAULT 'active', display_name text, primary_email text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_primary_email_uq ON accounts (lower(primary_email)) WHERE primary_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL, provider_subject text NOT NULL, email text, email_normalized text,
  email_verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
  UNIQUE(provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text NOT NULL, email text NOT NULL,
  email_normalized text NOT NULL, code_hash text NOT NULL, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
  send_count integer NOT NULL DEFAULT 1, last_sent_at timestamptz, ip text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_challenges_email_idx ON login_challenges(email_normalized, created_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, revoke_reason text, ip text, user_agent text, last_seen_at timestamptz
);
CREATE TABLE IF NOT EXISTS auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, account_id uuid, session_id uuid,
  email_normalized text, ip text, user_agent text, meta jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL,
  description text, is_system boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), screen text NOT NULL, action text NOT NULL,
  description text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(screen, action)
);
CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS account_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, assigned_by_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, UNIQUE(account_id, role_id)
);
CREATE TABLE IF NOT EXISTS account_permission_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, effect text NOT NULL,
  reason text, assigned_by_account_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id, permission_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, actor_type text NOT NULL,
  action text NOT NULL, resource_type text NOT NULL, resource_id text, reason text,
  payload jsonb, ip text, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, has_variants boolean NOT NULL DEFAULT false,
  default_front_design_url text, default_back_design_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS design_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), design_id uuid NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  code text NOT NULL, label text NOT NULL, dtf_asset_id uuid NOT NULL, public_preview_asset_id uuid,
  front_design_url text, back_design_url text, is_active boolean NOT NULL DEFAULT true,
  sort_rank integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(design_id, code)
);
CREATE TABLE IF NOT EXISTS informative_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_type text NOT NULL, scope_id uuid,
  asset_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, title text NOT NULL, description text,
  garment_type text NOT NULL, garment_model text, design_id uuid NOT NULL REFERENCES designs(id), category text NOT NULL,
  visibility text NOT NULL DEFAULT 'public', is_active boolean NOT NULL DEFAULT true,
  is_seasonal boolean NOT NULL DEFAULT false, sort_rank integer NOT NULL DEFAULT 0, price_mxn integer NOT NULL,
  cover_asset_id uuid, preview_front_asset_id uuid, preview_back_asset_id uuid, informative_image_id uuid,
  viewer_asset_id uuid, front_print_x_pct double precision NOT NULL DEFAULT 34,
  front_print_y_pct double precision NOT NULL DEFAULT 25, front_print_w_pct double precision NOT NULL DEFAULT 32,
  front_print_h_pct double precision NOT NULL DEFAULT 34, back_print_x_pct double precision NOT NULL DEFAULT 32,
  back_print_y_pct double precision NOT NULL DEFAULT 23, back_print_w_pct double precision NOT NULL DEFAULT 36,
  back_print_h_pct double precision NOT NULL DEFAULT 36,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS publication_mockups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES design_variants(id) ON DELETE SET NULL, garment_color text, mockup_asset_id uuid NOT NULL,
  view_side text NOT NULL DEFAULT 'front', mockup_url text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collections_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, title text NOT NULL, description text,
  visibility text NOT NULL DEFAULT 'public', cover_asset_id uuid, informative_image_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collection_set_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid NOT NULL REFERENCES collections_sets(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE, position_index integer NOT NULL DEFAULT 0,
  UNIQUE(collection_id, publication_id)
);
CREATE TABLE IF NOT EXISTS drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, title text NOT NULL, description text,
  status text NOT NULL DEFAULT 'preview', starts_at timestamptz, ends_at timestamptz, capacity_total integer,
  visibility text NOT NULL DEFAULT 'public', cover_asset_id uuid, informative_image_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drop_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), drop_id uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE, position_index integer NOT NULL DEFAULT 0,
  UNIQUE(drop_id, publication_id)
);
CREATE TABLE IF NOT EXISTS season_config (
  id integer PRIMARY KEY DEFAULT 1, is_enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'active', guest_session_id text,
  account_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  item_type text NOT NULL, publication_id uuid, publication_slug text, design_variant_id uuid,
  garment_type text NOT NULL, garment_model text NOT NULL DEFAULT '', color text NOT NULL, size text NOT NULL,
  grammage_g integer NOT NULL, fit text NOT NULL DEFAULT '', quantity integer NOT NULL CHECK(quantity > 0),
  unit_price_mxn integer NOT NULL CHECK(unit_price_mxn >= 0), custom_front jsonb, custom_back jsonb,
  custom_note text, improve_quality boolean NOT NULL DEFAULT false, drop_id uuid, drop_total_limit integer,
  meta jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cart_id uuid NOT NULL REFERENCES carts(id), status text NOT NULL DEFAULT 'pending',
  email text NOT NULL, phone text NOT NULL, address jsonb NOT NULL, shipping_method text NOT NULL,
  shipping_quote_id text, shipping_provider text, shipping_service text, shipping_cost_mxn integer NOT NULL DEFAULT 0,
  shipping_quotes jsonb, subtotal_mxn integer NOT NULL, total_mxn integer NOT NULL, currency text NOT NULL DEFAULT 'MXN',
  paid_at timestamptz, payment_attempt_id uuid, order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), checkout_session_id uuid NOT NULL, status text NOT NULL,
  amount_mxn integer NOT NULL, currency text NOT NULL DEFAULT 'MXN', provider text NOT NULL,
  provider_payment_intent_id text, provider_charge_id text, client_secret text, failure_reason text,
  metadata jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  checkout_session_id uuid NOT NULL, status text NOT NULL, amount_mxn integer NOT NULL,
  currency text NOT NULL DEFAULT 'MXN', provider text NOT NULL, provider_charge_id text,
  refunded_amount_mxn integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_transaction_id uuid NOT NULL REFERENCES payment_transactions(id),
  reason text NOT NULL, amount_mxn integer NOT NULL, status text NOT NULL, provider_refund_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), checkout_session_id uuid NOT NULL UNIQUE, payment_attempt_id uuid NOT NULL,
  payment_reference text NOT NULL, customer_email text NOT NULL, customer_phone text NOT NULL,
  shipping_method text NOT NULL, shipping_cost_mxn integer NOT NULL, subtotal_mxn integer NOT NULL,
  total_mxn integer NOT NULL, currency text NOT NULL DEFAULT 'MXN', address jsonb NOT NULL,
  status text NOT NULL DEFAULT 'paid', tracking_number text, tracking_carrier text, tracking_url text,
  shipping_label_url text, drop_id uuid, drop_number integer, drop_total_limit integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  cart_item_id uuid NOT NULL, item_type text NOT NULL, publication_id uuid, publication_slug text,
  design_variant_id uuid, garment_type text NOT NULL, garment_model text NOT NULL, color text NOT NULL,
  size text NOT NULL, grammage_g integer NOT NULL, fit text NOT NULL, quantity integer NOT NULL,
  unit_price_mxn integer NOT NULL, drop_id uuid, drop_total_limit integer, snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_state_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  previous_status text, new_status text NOT NULL, source text NOT NULL, reason text, changed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drop_counters (
  drop_id uuid PRIMARY KEY, last_number integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'pending',
  dtf_sent_to_print_at timestamptz, dtf_printed_at timestamptz, dtf_applied_at timestamptz,
  packed_at timestamptz, shipped_at timestamptz, delivered_at timestamptz,
  failures_count integer NOT NULL DEFAULT 0, last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(order_item_id)
);
CREATE TABLE IF NOT EXISTS work_order_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  order_id uuid NOT NULL, order_item_id uuid NOT NULL, reason_code text NOT NULL, notes text,
  quantity integer NOT NULL, merma_reference text NOT NULL UNIQUE, inventory_response jsonb,
  recorded_by text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), garment_type text NOT NULL, garment_model text NOT NULL DEFAULT '',
  color text NOT NULL, size text NOT NULL, grammage_g integer NOT NULL, fit text NOT NULL DEFAULT '',
  quantity integer NOT NULL DEFAULT 0, supplier_cost_mxn numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(garment_type, garment_model, color, size, grammage_g, fit)
);
CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  movement_type text NOT NULL, quantity integer NOT NULL, reason text, actor text, source_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements(inventory_item_id, created_at DESC);
CREATE TABLE IF NOT EXISTS stock_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL, supplier_name text, unit_cost_mxn numeric(12,2), source_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE, shipping_method text NOT NULL,
  status text NOT NULL, provider text, provider_shipment_id text, quotation_id text, rate_id text,
  tracking_number text, tracking_carrier text, tracking_url text, label_url text, local_route_date date,
  local_ready_at timestamptz, out_for_delivery_at timestamptz, shipped_at timestamptz, delivered_at timestamptz,
  failed_at timestamptz, failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  event_type text NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS local_address_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shipment_id uuid, order_id uuid NOT NULL,
  old_address jsonb NOT NULL, new_address jsonb NOT NULL, reason text, changed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS local_delivery_evidences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  photo_url text, notes text, created_by text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'open', reason text NOT NULL,
  priority text, subject text, customer_type text NOT NULL, account_id uuid, contact_email text NOT NULL,
  contact_phone text, guest_email text, guest_order_code text, linked_order_id uuid, linked_order_code text,
  is_order_related boolean NOT NULL DEFAULT false, metadata jsonb, assigned_to text, created_by text,
  closed_at timestamptz, last_message_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_case_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  sender_type text NOT NULL, sender_account_id uuid, sender_label text, message text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_case_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES support_case_messages(id) ON DELETE CASCADE, asset_id uuid,
  file_url text NOT NULL, file_name text, mime_type text, size_bytes bigint, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_case_order_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  order_id uuid NOT NULL, order_code text NOT NULL, link_method text NOT NULL, created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id, order_id)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), template_key text NOT NULL, channel text NOT NULL,
  recipient text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 0,
  last_error text, provider_message_id text, next_retry_at timestamptz, delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_ref text, event_type text NOT NULL, order_id uuid,
  payment_attempt_id uuid, support_case_id uuid, work_order_id uuid, publication_id uuid, collection_id uuid,
  drop_id uuid, item_type text, garment_type text, garment_model text, color text, size text, grammage_g integer,
  fit text, shipping_method text, shipping_provider text, status text, state_code text, quantity integer,
  amount_mxn integer, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_event_ref_uq ON analytics_events(event_ref);
CREATE TABLE IF NOT EXISTS sales_pings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_ref text, order_id uuid NOT NULL, payment_attempt_id uuid,
  publication_id uuid, publication_slug text, collection_id uuid, drop_id uuid, item_type text,
  garment_type text, garment_model text, color text, size text, grammage_g integer, fit text,
  quantity integer NOT NULL, amount_mxn integer NOT NULL, shipping_method text NOT NULL,
  shipping_provider text, state_code text, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_ping_event_ref_uq ON sales_pings(event_ref);

CREATE TABLE IF NOT EXISTS sku_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), garment_type text NOT NULL, garment_model text NOT NULL DEFAULT '',
  color text NOT NULL, size text NOT NULL, grammage_g integer NOT NULL, fit text NOT NULL DEFAULT '',
  sale_price_mxn integer NOT NULL, provider_price_mxn integer NOT NULL DEFAULT 0,
  dtf_cost_mxn integer NOT NULL DEFAULT 0, packaging_cost_mxn integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(garment_type, garment_model, color, size, grammage_g, fit)
);
CREATE TABLE IF NOT EXISTS customizer_pricing_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), base_price_mxn integer NOT NULL,
  per_image_price_mxn integer NOT NULL, included_images integer NOT NULL DEFAULT 0,
  max_images integer NOT NULL DEFAULT 10, quality_upgrade_price_mxn integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), object_key text NOT NULL UNIQUE, file_name text,
  content_type text NOT NULL, visibility text NOT NULL DEFAULT 'private', category text,
  size_bytes bigint NOT NULL DEFAULT 0, etag text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
