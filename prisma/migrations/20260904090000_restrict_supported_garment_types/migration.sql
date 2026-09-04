ALTER TABLE publications
  ADD CONSTRAINT publications_supported_garment_type
  CHECK (garment_type IN ('tshirt', 'hoodie')) NOT VALID;

ALTER TABLE cart_items
  ADD CONSTRAINT cart_items_supported_garment_type
  CHECK (garment_type IN ('tshirt', 'hoodie')) NOT VALID;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_supported_garment_type
  CHECK (garment_type IN ('tshirt', 'hoodie')) NOT VALID;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_supported_garment_type
  CHECK (garment_type IN ('tshirt', 'hoodie')) NOT VALID;

ALTER TABLE sku_pricing_rules
  ADD CONSTRAINT sku_pricing_rules_supported_garment_type
  CHECK (garment_type IN ('tshirt', 'hoodie')) NOT VALID;
