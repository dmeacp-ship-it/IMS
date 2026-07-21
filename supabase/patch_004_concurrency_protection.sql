-- ============================================================================
-- Virgo ACP IMS — patch_004_concurrency_protection.sql
-- Enforces transactional concurrency protection at the database level by
-- rejecting inserts to stock_conversions if the branch does not have enough
-- closing stock of the consumed item/batch.
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_negative_conversion()
RETURNS TRIGGER AS $$
DECLARE
  v_closing_qty NUMERIC;
BEGIN
  -- Query the current closing quantity from the ledger view
  SELECT closing_qty INTO v_closing_qty
  FROM item_stock_ledger
  WHERE branch_code = NEW.branch_code
    AND item_name = upper(trim(NEW.from_item_name))
    AND batch = upper(trim(NEW.from_batch));

  IF v_closing_qty IS NULL THEN
    v_closing_qty := 0;
  END IF;

  -- Throw exception if consumption exceeds available stock
  IF NEW.from_quantity > v_closing_qty THEN
    RAISE EXCEPTION 'Concurrency Lock: Only % available for % (batch: %), cannot consume %.',
      v_closing_qty, NEW.from_item_name, NEW.from_batch, NEW.from_quantity;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it already exists
DROP TRIGGER IF EXISTS trg_prevent_negative_conversion ON stock_conversions;

-- Attach trigger
CREATE TRIGGER trg_prevent_negative_conversion
BEFORE INSERT ON stock_conversions
FOR EACH ROW
EXECUTE FUNCTION prevent_negative_conversion();
