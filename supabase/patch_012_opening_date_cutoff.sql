-- ============================================================================
-- Virgo ACP IMS — patch_012_opening_date_cutoff.sql
-- Makes the opening stock as_of_date an actual CUT-OFF.
--
-- Bug being fixed: item_stock_ledger summed ALL sales/transfers/returns for an
-- item, ignoring the opening count's as_of_date. Because an opening count
-- already reflects every movement up to that date, movements dated BEFORE the
-- opening were being counted a second time — producing wrong (often negative)
-- closings.
--
-- Fix: transaction-sourced flows (outward, received-transfer inward, sales
-- returns) now only count rows dated STRICTLY AFTER each item+batch's opening
-- as_of_date. Keys with no opening recorded keep counting everything (there is
-- no baseline to double-count). Conversions and adjustments are NOT date-
-- filtered: they are manual in-app events entered after opening is set up, and
-- adjustments are corrections meant to move the current balance.
--
-- Convention: opening = balance at END of the as_of date, so the cut-off is
-- doc_date > as_of_date (same-day transactions are treated as already counted).
--
-- Idempotent: safe to re-run. Run AFTER patch_011.
-- NOTE: this will change many closing_qty values to their correct figures.
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
-- Dispatched out of the source branch (customer sales + transfers out), only
-- after that branch's opening date for the item.
outward as (
  select t.source_branch_code as branch_code, t.item_name, t.batch, sum(t.quantity) as qty
  from txn t
  left join opening o
    on o.branch_code = t.source_branch_code
   and o.item_name  = t.item_name
   and o.batch      = t.batch
  where t.source_branch_code is not null
    and (o.as_of_date is null or t.doc_date > o.as_of_date)
  group by 1, 2, 3
),
-- Transfers received at the destination branch, only after that branch's
-- opening date for the item.
inward_transfer as (
  select t.destination_branch_code as branch_code, t.item_name, t.batch, sum(t.quantity) as qty
  from txn t
  left join opening o
    on o.branch_code = t.destination_branch_code
   and o.item_name  = t.item_name
   and o.batch      = t.batch
  where t.order_type = 'BRANCH-TRANSFER'
    and t.status = 'RECEIVED'
    and t.destination_branch_code is not null
    and (o.as_of_date is null or t.doc_date > o.as_of_date)
  group by 1, 2, 3
),
-- Customer returns back into the source branch, only after its opening date.
sales_return as (
  select r.source_branch_code as branch_code, r.item_name, r.batch, sum(r.quantity) as qty
  from ret r
  left join opening o
    on o.branch_code = r.source_branch_code
   and o.item_name  = r.item_name
   and o.batch      = r.batch
  where r.source_branch_code is not null
    and (o.as_of_date is null or r.doc_date > o.as_of_date)
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
