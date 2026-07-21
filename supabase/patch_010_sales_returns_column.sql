-- ============================================================================
-- Virgo ACP IMS — patch_010_sales_returns_column.sql
-- Surfaces SALES RETURNS as its own ledger column.
--
-- patch_008 folded sales returns INTO inward_qty. This splits them back out
-- into a dedicated `sales_return_qty` so the UI can show a distinct column and
-- each row still balances:
--     closing = opening + inward + sales_return - outward
-- The numeric closing_qty is UNCHANGED from patch_008 — only the breakdown
-- moves — so conversions, the variance report, and every other consumer that
-- reads closing_qty are unaffected.
--
-- Idempotent: safe to re-run. Run AFTER patch_008.
-- ============================================================================

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
)
select
  k.branch_code,
  k.item_name,
  k.batch,
  coalesce(os.quantity, 0) as opening_qty,
  -- Inward now EXCLUDES sales returns; returns are reported separately.
  coalesce(it.qty, 0) + coalesce(ci.qty, 0) as inward_qty,
  coalesce(sr.qty, 0) as sales_return_qty,
  coalesce(o.qty, 0) + coalesce(co.qty, 0) as outward_qty,
  coalesce(os.quantity, 0) + coalesce(it.qty, 0) + coalesce(ci.qty, 0) + coalesce(sr.qty, 0)
    - coalesce(o.qty, 0) - coalesce(co.qty, 0) as closing_qty,
  os.as_of_date as opening_as_of_date
from keys k
left join opening         os using (branch_code, item_name, batch)
left join outward         o  using (branch_code, item_name, batch)
left join inward_transfer it using (branch_code, item_name, batch)
left join sales_return    sr using (branch_code, item_name, batch)
left join conv_out        co using (branch_code, item_name, batch)
left join conv_in         ci using (branch_code, item_name, batch);
