ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_quantity_nonnegative CHECK (quantity >= 0);
