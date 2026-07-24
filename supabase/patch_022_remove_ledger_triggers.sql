-- Drop the AFTER INSERT triggers on sales_transactions and stock_conversions
-- that were causing "cannot refresh materialized view concurrently" errors
-- during bulk Google Sheets synchronization.
--
-- The application code (lib/data.js) now explicitly calls 
-- refresh_item_stock_ledger() at the end of bulk operations
-- to ensure the ledger remains up to date without conflicting.

drop trigger if exists trg_auto_refresh_ledger_txns on sales_transactions;
drop trigger if exists trg_auto_refresh_ledger_conv on stock_conversions;
