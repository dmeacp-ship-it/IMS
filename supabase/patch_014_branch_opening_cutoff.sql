-- ============================================================================
-- Virgo ACP IMS — patch_014_branch_opening_cutoff.sql
-- Applies a branch-level opening-date cut-off to items that have NO opening row.
--
-- Problem: patch_012/013 only date-filtered items that had their own opening
-- row. An item with no opening count (opening = 0) still counted ALL its
-- dispatches — including ones dated before the branch's opening count — which
-- produced phantom NEGATIVE stock (e.g. a dispatch in Oct 2025 for a branch
-- counted on 2025-12-18).
--
-- Fix: once a branch has any opening stock recorded, treat its opening date as
-- the cut-off for EVERY item at that branch. Effective cut-off per item =
--   coalesce(that item's own opening as_of_date, the branch's opening date).
-- The branch date is max(as_of_date) over that branch's opening rows (they are
-- normally a single date from one bulk upload). Branches with no opening at all
-- keep counting everything. Cut-off is inclusive (doc_date >= cut-off), matching
-- patch_013.
--
-- Effect: pre-opening dispatches for un-counted items are excluded, so their
-- closing is 0 instead of negative. A negative closing now genuinely means
-- "more went out than opening + inward AFTER the opening date" — a real issue.
--
-- Idempotent: safe to re-run. Fully redefines the view; supersedes patch_013.
-- ============================================================================

drop view if exists item_stock_ledger cascade;

create or replace view item_stock_ledger as
with opening as (
  select branch_code,
         upper(trim(item_name)) as item_name,
         upper(trim(batch))     as batch,
         quantity,
         as_of_date
  from opening_stock
),
-- One opening cut-off date per branch (latest opening count date at that branch).
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
    upper(trim(batch)) as batch,
    quantity
  from sales_transactions
),
ret as (
  select
    source_branch_code,
    doc_date,
    upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
    upper(trim(batch)) as batch,
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
