-- ============================================================================
-- Virgo ACP IMS — patch_009_conversion_lock.sql
-- Fixes a race in the stock-conversion guard (patch_004).
--
-- Problem: prevent_negative_conversion() reads closing_qty from the
-- item_stock_ledger VIEW and rejects if there isn't enough stock. Under
-- Postgres's default READ COMMITTED isolation, two concurrent conversion
-- inserts for the SAME branch+item+batch each take their own snapshot,
-- neither sees the other's uncommitted row, so both checks pass and both
-- commit — overdrawing stock. A BEFORE INSERT check against a derived view
-- cannot prevent this on its own.
--
-- Fix: take a transaction-scoped advisory lock keyed on
-- branch_code+from_item_name+from_batch at the top of the trigger. Concurrent
-- transactions touching the same key now serialize — the second waits for the
-- first to commit, then re-reads the ledger (which now reflects the first
-- conversion) and correctly rejects if stock is insufficient. Different keys
-- don't contend, so throughput is unaffected for unrelated items.
--
-- Idempotent: safe to re-run. Run AFTER patch_004.
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_negative_conversion()
RETURNS TRIGGER AS $$
DECLARE
  v_closing_qty NUMERIC;
  v_item text := upper(trim(NEW.from_item_name));
  v_batch text := upper(trim(NEW.from_batch));
BEGIN
  -- Serialize concurrent conversions of the same branch+item+batch. Two bigint
  -- lock keys derived from a stable hash of the composite key; released
  -- automatically at transaction end (commit or rollback).
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.branch_code || '|' || v_item || '|' || v_batch, 0)
  );

  -- Re-read current closing quantity AFTER acquiring the lock, so it reflects
  -- any conversion that just committed on this same key.
  SELECT closing_qty INTO v_closing_qty
  FROM item_stock_ledger
  WHERE branch_code = NEW.branch_code
    AND item_name = v_item
    AND batch = v_batch;

  IF v_closing_qty IS NULL THEN
    v_closing_qty := 0;
  END IF;

  IF NEW.from_quantity > v_closing_qty THEN
    RAISE EXCEPTION 'Concurrency Lock: Only % available for % (batch: %), cannot consume %.',
      v_closing_qty, NEW.from_item_name, NEW.from_batch, NEW.from_quantity;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure the trigger exists (no-op if patch_004 already created it).
DROP TRIGGER IF EXISTS trg_prevent_negative_conversion ON stock_conversions;
CREATE TRIGGER trg_prevent_negative_conversion
BEFORE INSERT ON stock_conversions
FOR EACH ROW
EXECUTE FUNCTION prevent_negative_conversion();
