-- ============================================================================
-- Patch 003: key the stock ledger by ITEM NAME (without the "VIRGO " prefix)
-- instead of the SAP FG item code.
--
-- Run this on your LIVE database — it preserves users and synced sales data.
-- (schema_full_reset.sql has also been updated to match, for future rebuilds.)
--
-- Why: the branch STOCK sheets (and the opening-stock counts being uploaded)
-- identify items by name like "ALFA3030-VL300-2440X1220" — no FG code, no
-- VIRGO prefix. SAP's item_description carries "VIRGO " in front; stripping
-- it makes the two worlds join on the same key.
-- ============================================================================

alter table opening_stock rename column item_code to item_name;
alter table stock_conversions rename column from_item_code to from_item_name;
alter table stock_conversions rename column to_item_code to to_item_name;

drop view if exists item_stock_ledger;

create view item_stock_ledger as
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
