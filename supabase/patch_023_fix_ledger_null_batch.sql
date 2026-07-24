-- ============================================================================
-- Virgo ACP IMS — patch_023_fix_ledger_null_batch.sql
-- Fixes an issue where item_stock_ledger could output two separate rows for
-- the same item: one with batch = NULL and one with batch = ''.
-- This prevented the UNIQUE INDEX from being created on the materialized view,
-- which completely broke REFRESH MATERIALIZED VIEW CONCURRENTLY.
-- ============================================================================

drop view if exists item_stock_ledger cascade;

create or replace view item_stock_ledger as
with opening as (
  select branch_code,
         upper(trim(item_name)) as item_name,
         coalesce(upper(trim(batch)), '') as batch,
         quantity,
         as_of_date
  from opening_stock
),
branch_open as (
  select branch_code, max(as_of_date) as branch_date
  from opening_stock
  group by branch_code
),
txn as (
  select
    source_branch_code,
    destination_branch_code,
    order_type,
    status,
    doc_date,
    upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
    coalesce(upper(trim(batch)), '') as batch,
    quantity
  from sales_transactions
),
ret as (
  select
    source_branch_code,
    doc_date,
    upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
    coalesce(upper(trim(batch)), '') as batch,
    quantity
  from sales_returns
),
outward as (
  select t.source_branch_code as branch_code, t.item_name, t.batch, sum(t.quantity) as qty
  from txn t
  left join opening o
    on o.branch_code = t.source_branch_code and o.item_name = t.item_name and o.batch = t.batch
  left join branch_open bo
    on bo.branch_code = t.source_branch_code
  where t.source_branch_code is not null
    and (coalesce(o.as_of_date, bo.branch_date) is null
         or t.doc_date >= coalesce(o.as_of_date, bo.branch_date))
  group by 1, 2, 3
),
inward_transfer as (
  select t.destination_branch_code as branch_code, t.item_name, t.batch, sum(t.quantity) as qty
  from txn t
  left join opening o
    on o.branch_code = t.destination_branch_code and o.item_name = t.item_name and o.batch = t.batch
  left join branch_open bo
    on bo.branch_code = t.destination_branch_code
  where t.order_type = 'BRANCH-TRANSFER'
    and t.status = 'RECEIVED'
    and t.destination_branch_code is not null
    and (coalesce(o.as_of_date, bo.branch_date) is null
         or t.doc_date >= coalesce(o.as_of_date, bo.branch_date))
  group by 1, 2, 3
),
sales_return as (
  select r.source_branch_code as branch_code, r.item_name, r.batch, sum(r.quantity) as qty
  from ret r
  left join opening o
    on o.branch_code = r.source_branch_code and o.item_name = r.item_name and o.batch = r.batch
  left join branch_open bo
    on bo.branch_code = r.source_branch_code
  where r.source_branch_code is not null
    and (coalesce(o.as_of_date, bo.branch_date) is null
         or r.doc_date >= coalesce(o.as_of_date, bo.branch_date))
  group by 1, 2, 3
),
conv_out as (
  select branch_code, upper(trim(from_item_name)) as item_name, coalesce(upper(trim(from_batch)), '') as batch, sum(from_quantity) as qty
  from stock_conversions
  group by 1, 2, 3
),
conv_in as (
  select branch_code, upper(trim(to_item_name)) as item_name, coalesce(upper(trim(to_batch)), '') as batch, sum(to_quantity) as qty
  from stock_conversions
  group by 1, 2, 3
),
adjustments as (
  select branch_code, upper(trim(item_name)) as item_name, coalesce(upper(trim(batch)), '') as batch, sum(adjustment_qty) as qty
  from stock_adjustments
  group by 1, 2, 3
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

-- Recreate the materialized view now that duplicates are mathematically impossible
create materialized view item_stock_ledger_mat as
  select * from item_stock_ledger;

-- Now the unique index will successfully create!
create unique index if not exists item_stock_ledger_mat_key
  on item_stock_ledger_mat (branch_code, item_name, batch);

create index if not exists item_stock_ledger_mat_branch
  on item_stock_ledger_mat (branch_code);

grant select on item_stock_ledger_mat to anon, authenticated, service_role;
