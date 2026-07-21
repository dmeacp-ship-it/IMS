-- ============================================================================
-- Virgo ACP IMS — patch_011_stock_adjustments.sql
-- Phase 2: ledger-adjusting reconciliations.
--
-- Adds a stock_adjustments table — signed one-time corrections applied to a
-- branch+item+batch so the ledger closing balance can be reconciled to a
-- physical count. Each adjustment optionally links back to the physical
-- reconciliation that justified it. Adjustments are append-only: a mistaken
-- adjustment is corrected by posting another one, never edited/deleted, so the
-- audit trail stays intact.
--
-- The item_stock_ledger view is redefined to fold sum(adjustment_qty) into
-- closing_qty and expose it as its own `adjustment_qty` column, so corrected
-- balances are never silent. All other columns are unchanged.
--
-- Idempotent: safe to re-run. Run AFTER patch_010.
-- ============================================================================

create table if not exists stock_adjustments (
  id                bigint generated always as identity primary key,
  branch_code       text not null references branches(code),
  item_name         text not null,
  batch             text not null default '',
  adjustment_qty    numeric not null,                 -- signed delta applied to closing
  reason            text,
  reconciliation_id uuid references physical_reconciliations(id),
  created_by        uuid references user_profiles(id),
  created_at        timestamptz not null default now()
);

create index if not exists idx_stock_adj_branch on stock_adjustments(branch_code);
create index if not exists idx_stock_adj_key on stock_adjustments(branch_code, item_name, batch);

drop view if exists item_stock_ledger cascade;

create or replace view item_stock_ledger as
with txn as (
  select
    source_branch_code,
    destination_branch_code,
    order_type,
    status,
    upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
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
sales_return as (
  select source_branch_code as branch_code,
         upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
         upper(trim(batch)) as batch,
         sum(quantity) as qty
  from sales_returns
  where source_branch_code is not null
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
adjustments as (
  select branch_code, upper(trim(item_name)) as item_name, upper(trim(batch)) as batch, sum(adjustment_qty) as qty
  from stock_adjustments
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
  union select branch_code, item_name, batch from sales_return
  union select branch_code, item_name, batch from conv_out
  union select branch_code, item_name, batch from conv_in
  union select branch_code, item_name, batch from adjustments
)
select
  k.branch_code,
  k.item_name,
  k.batch,
  coalesce(os.quantity, 0) as opening_qty,
  coalesce(it.qty, 0) + coalesce(ci.qty, 0) as inward_qty,
  coalesce(sr.qty, 0) as sales_return_qty,
  coalesce(o.qty, 0) + coalesce(co.qty, 0) as outward_qty,
  coalesce(adj.qty, 0) as adjustment_qty,
  coalesce(os.quantity, 0) + coalesce(it.qty, 0) + coalesce(ci.qty, 0)
    + coalesce(sr.qty, 0) + coalesce(adj.qty, 0)
    - coalesce(o.qty, 0) - coalesce(co.qty, 0) as closing_qty,
  os.as_of_date as opening_as_of_date
from keys k
left join opening         os  using (branch_code, item_name, batch)
left join outward         o   using (branch_code, item_name, batch)
left join inward_transfer it  using (branch_code, item_name, batch)
left join sales_return    sr  using (branch_code, item_name, batch)
left join conv_out        co  using (branch_code, item_name, batch)
left join conv_in         ci  using (branch_code, item_name, batch)
left join adjustments     adj using (branch_code, item_name, batch);
