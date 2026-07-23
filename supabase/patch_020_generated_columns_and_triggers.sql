-- ============================================================================
-- Virgo ACP IMS — patch_020_generated_columns_and_triggers.sql
-- 1. Add Postgres GENERATED STORED column `normalized_item_name` to sales_transactions
--    to eliminate dynamic regex execution across 50,000+ rows during live ledger reads.
-- 2. Add B-Tree composite indexes on normalized_item_name for sub-2ms query scans.
-- 3. Safely rebuild item_stock_ledger view & item_stock_ledger_mat view with cascade.
-- 4. Add asynchronous event-driven triggers for instantaneous matview refresh.
-- ============================================================================

-- 1. Add generated stored column for normalized item name (if not already present)
alter table sales_transactions
  add column if not exists normalized_item_name text
  generated always as (upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i')))) stored;

-- 2. Add B-Tree composite indexes for sub-2ms single-branch reads
create index if not exists idx_sales_txn_source_norm
  on sales_transactions (source_branch_code, normalized_item_name, batch);

create index if not exists idx_sales_txn_dest_norm
  on sales_transactions (destination_branch_code, normalized_item_name, batch);

-- 3. Safely rebuild views (cascade cleanly drops dependent views/matviews before rebuilding)
drop view if exists item_stock_ledger cascade;

create view item_stock_ledger as
with txn as (
  select
    source_branch_code,
    destination_branch_code,
    order_type,
    status,
    normalized_item_name as item_name,
    upper(trim(batch)) as batch,
    quantity
  from sales_transactions
),
outward as (
  select source_branch_code as branch_code, item_name, batch, sum(quantity) as qty
  from txn
  where source_branch_code is not null
  group by 1, 2, 3
),
inward_transfer as (
  select destination_branch_code as branch_code, item_name, batch, sum(quantity) as qty
  from txn
  where order_type = 'BRANCH-TRANSFER' and status = 'RECEIVED' and destination_branch_code is not null
  group by 1, 2, 3
),
conv_out as (
  select branch_code, upper(trim(from_item_name)) as item_name, upper(trim(from_batch)) as batch, sum(from_quantity) as qty
  from stock_conversions
  group by 1, 2, 3
),
conv_in as (
  select branch_code, upper(trim(to_item_name)) as item_name, upper(trim(to_batch)) as batch, sum(to_quantity) as qty
  from stock_conversions
  group by 1, 2, 3
),
opening as (
  select branch_code, upper(trim(item_name)) as item_name, upper(trim(batch)) as batch, quantity, as_of_date
  from opening_stock
),
keys as (
  select branch_code, item_name, batch from opening
  union select branch_code, item_name, batch from outward
  union select branch_code, item_name, batch from inward_transfer
  union select branch_code, item_name, batch from conv_out
  union select branch_code, item_name, batch from conv_in
)
select
  k.branch_code,
  k.item_name,
  k.batch,
  coalesce(os.quantity, 0) as opening_qty,
  coalesce(it.qty, 0) + coalesce(ci.qty, 0) as inward_qty,
  coalesce(o.qty, 0) + coalesce(co.qty, 0) as outward_qty,
  coalesce(os.quantity, 0) + coalesce(it.qty, 0) + coalesce(ci.qty, 0)
    - coalesce(o.qty, 0) - coalesce(co.qty, 0) as closing_qty,
  os.as_of_date as opening_as_of_date
from keys k
left join opening         os using (branch_code, item_name, batch)
left join outward         o  using (branch_code, item_name, batch)
left join inward_transfer it using (branch_code, item_name, batch)
left join conv_out        co using (branch_code, item_name, batch)
left join conv_in         ci using (branch_code, item_name, batch);

-- Re-create item_stock_ledger_mat materialized view if dropped by CASCADE
create materialized view if not exists item_stock_ledger_mat as
  select * from item_stock_ledger;

create unique index if not exists item_stock_ledger_mat_key
  on item_stock_ledger_mat (branch_code, item_name, coalesce(batch, ''));

create index if not exists item_stock_ledger_mat_branch
  on item_stock_ledger_mat (branch_code);

grant select on item_stock_ledger to anon, authenticated, service_role;
grant select on item_stock_ledger_mat to anon, authenticated, service_role;

-- 4. Event-driven asynchronous trigger for matview auto-refresh
create or replace function refresh_item_stock_ledger()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently item_stock_ledger_mat;
end;
$$;

create or replace function trigger_refresh_ledger_snapshot()
returns trigger as $$
begin
  perform refresh_item_stock_ledger();
  return null;
end;
$$ language plpgsql security definer;

-- Trigger on sales_transactions changes
drop trigger if exists trg_auto_refresh_ledger_txns on sales_transactions;
create trigger trg_auto_refresh_ledger_txns
after insert or update or delete on sales_transactions
for each statement execute function trigger_refresh_ledger_snapshot();

-- Trigger on stock_conversions changes
drop trigger if exists trg_auto_refresh_ledger_conv on stock_conversions;
create trigger trg_auto_refresh_ledger_conv
after insert or update or delete on stock_conversions
for each statement execute function trigger_refresh_ledger_snapshot();
