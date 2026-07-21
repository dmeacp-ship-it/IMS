-- ============================================================================
-- Virgo ACP IMS — patch_007_audit_and_sync_logs.sql
-- Creates activity logs, sync history, and physical reconciliation tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_activity_logs (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  action text not null,
  details text,
  created_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid primary key default gen_random_uuid(),
  triggered_by text not null,
  status text not null,
  synced_count integer default 0,
  details text,
  created_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS physical_reconciliations (
  id uuid primary key default gen_random_uuid(),
  branch_code text not null,
  audited_by text not null,
  item_name text not null,
  batch text not null,
  ledger_qty numeric not null,
  physical_qty numeric not null,
  variance numeric not null,
  created_at timestamptz not null default now()
);
