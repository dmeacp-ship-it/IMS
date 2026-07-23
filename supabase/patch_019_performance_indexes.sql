-- ============================================================================
-- Virgo ACP IMS — patch_019_performance_indexes.sql
-- Add targeted composite indexes on high-traffic transaction, reconciliation,
-- and ledger tables to accelerate branch filtering, rate mapping, and variance queries.
-- ============================================================================

-- Composite index for branch transfer status queries (mergeInTransitIntoLedger)
create index if not exists idx_sales_txn_bt_dest_status
  on sales_transactions (order_type, status, destination_branch_code);

-- Partial index for rate map lookup (_itemRateMap)
create index if not exists idx_sales_txn_rate_lookup
  on sales_transactions (doc_date desc, item_description, rate_per_sqm)
  where rate_per_sqm is not null;

-- Composite index for physical reconciliations lookup (getVarianceReport)
create index if not exists idx_physical_recon_branch_created
  on physical_reconciliations (branch_code, created_at desc);

-- Composite index for order plan lines (getOrderPlanning)
create index if not exists idx_order_plan_lines_branch
  on order_plan_lines (branch_code, item_name);

-- Index for activity logs order query
create index if not exists idx_activity_logs_created
  on system_activity_logs (created_at desc);
