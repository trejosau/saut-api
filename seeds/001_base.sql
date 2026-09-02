INSERT INTO roles (code, name, description, is_system) VALUES
  ('admin', 'Administrador', 'Acceso total a la plataforma', true),
  ('operator', 'Operación', 'Operación de pedidos, inventario y envíos', true),
  ('support', 'Soporte', 'Gestión de casos de soporte', true),
  ('customer', 'Cliente', 'Cuenta de cliente', true)
ON CONFLICT (code) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO permissions (screen, action, description) VALUES
  ('dashboard', 'view', 'Acceso al dashboard'),
  ('catalog', 'read', 'Consultar catálogo'), ('catalog', 'write', 'Administrar catálogo'),
  ('inventory', 'read', 'Consultar inventario'), ('inventory', 'write', 'Administrar inventario'),
  ('orders', 'read', 'Consultar pedidos'), ('orders', 'write', 'Administrar pedidos'),
  ('shipping', 'read', 'Consultar envíos'), ('shipping', 'write', 'Administrar envíos'),
  ('support', 'read', 'Consultar soporte'), ('support', 'write', 'Administrar soporte'),
  ('analytics', 'read', 'Consultar analítica'), ('assets', 'read', 'Consultar assets internos'),
  ('assets', 'write', 'Administrar assets internos'), ('pricing', 'read', 'Consultar configuración de precios'),
  ('pricing', 'write', 'Administrar configuración de precios'), ('notifications', 'read', 'Consultar notificaciones'),
  ('notifications', 'write', 'Reintentar notificaciones'), ('auth', 'rbac_manage', 'Administrar acceso'),
  ('auth', 'audit_read', 'Consultar auditoría'), ('payments', 'refund', 'Emitir reembolsos')
ON CONFLICT (screen, action) DO UPDATE SET description = excluded.description;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.screen IN ('dashboard','orders','inventory','shipping','analytics')
WHERE r.code = 'operator' ON CONFLICT (role_id, permission_id) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.screen IN ('dashboard','support','orders')
WHERE r.code = 'support' ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO designs (id, name, has_variants, default_front_design_url, default_back_design_url)
VALUES ('11000000-0000-0000-0000-000000000001', 'Galaxias', true, '/tiles/design-1.webp', null)
ON CONFLICT (id) DO NOTHING;
INSERT INTO design_variants (id, design_id, code, label, dtf_asset_id, front_design_url, is_active, sort_rank)
VALUES ('12000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'default', 'Default',
  '20000000-0000-0000-0000-000000000001', '/tiles/design-1.webp', true, 10)
ON CONFLICT (id) DO NOTHING;
INSERT INTO publications (
  id, slug, title, description, garment_type, garment_model, design_id, category, visibility,
  is_active, is_seasonal, sort_rank, price_mxn, front_print_x_pct, front_print_y_pct,
  front_print_w_pct, front_print_h_pct, back_print_x_pct, back_print_y_pct, back_print_w_pct, back_print_h_pct
) VALUES (
  '13000000-0000-0000-0000-000000000001', 'galaxias', 'Galaxias', 'Diseño SAUT', 'tshirt', 'oversize',
  '11000000-0000-0000-0000-000000000001', 'playeras', 'public', true, false, 100, 699,
  34, 25, 32, 34, 32, 23, 36, 36
) ON CONFLICT (id) DO NOTHING;
INSERT INTO collections_sets (id, slug, title, description, visibility)
VALUES ('14000000-0000-0000-0000-000000000001', 'esenciales', 'Esenciales', 'Selección SAUT', 'public')
ON CONFLICT (id) DO NOTHING;
INSERT INTO collection_set_items (collection_id, publication_id, position_index)
VALUES ('14000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 1)
ON CONFLICT (collection_id, publication_id) DO NOTHING;
INSERT INTO drops (id, slug, title, description, status, capacity_total, visibility)
VALUES ('15000000-0000-0000-0000-000000000001', 'drop-inicial', 'Drop inicial', 'Primer drop SAUT', 'active', 500, 'public')
ON CONFLICT (id) DO NOTHING;
INSERT INTO drop_items (drop_id, publication_id, position_index)
VALUES ('15000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 1)
ON CONFLICT (drop_id, publication_id) DO NOTHING;
INSERT INTO season_config (id, is_enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory_items (garment_type, garment_model, color, size, grammage_g, fit, quantity, supplier_cost_mxn)
VALUES
  ('tshirt','oversize','Negra','S',240,'',100,150),
  ('tshirt','oversize','Negra','M',240,'',100,150),
  ('tshirt','oversize','Negra','L',240,'',100,150),
  ('tshirt','oversize','Blanca','M',240,'',100,150)
ON CONFLICT (garment_type, garment_model, color, size, grammage_g, fit) DO NOTHING;

INSERT INTO sku_pricing_rules (
  garment_type, garment_model, color, size, grammage_g, fit, sale_price_mxn,
  provider_price_mxn, dtf_cost_mxn, packaging_cost_mxn, is_active
) VALUES ('tshirt','oversize','Negra','M',240,'',699,150,80,25,true)
ON CONFLICT (garment_type, garment_model, color, size, grammage_g, fit) DO NOTHING;
INSERT INTO customizer_pricing_configs (base_price_mxn, per_image_price_mxn, included_images, max_images, quality_upgrade_price_mxn, is_active)
SELECT 499, 50, 0, 10, 80, true WHERE NOT EXISTS (SELECT 1 FROM customizer_pricing_configs WHERE is_active = true);
