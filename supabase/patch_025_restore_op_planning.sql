-- ============================================================================
-- Virgo ACP IMS — patch_025_restore_op_planning.sql
--
-- ROOT CAUSE: patch_024_fix_branch_opening_date_cutoff.sql rebuilds the ledger
-- with `drop view item_stock_ledger cascade` and
-- `drop materialized view item_stock_ledger_mat cascade`. op_planning's `stock`
-- CTE reads from item_stock_ledger_mat, so BOTH cascades drop op_planning — but
-- that patch never recreates it. Result: `op_planning` no longer exists, the
-- Order Planning screen returns 0 rows and renders the "No planning data" empty
-- state, and refresh_order_planning() errors with "relation op_planning does
-- not exist".
--
-- This patch recreates op_planning (the 45-day in-transit window version from
-- patch_024_fix_in_transit_window) and refreshes it. It is idempotent and safe
-- to re-run. op_national_rating / op_branch_grade are NOT dropped by the ledger
-- cascade (they depend on op_sales_norm, not the ledger), so they are left as-is
-- and only refreshed.
--
-- IMPORTANT for future ledger patches: any patch that does
--   drop [materialized] view ... item_stock_ledger[_mat] cascade
-- MUST recreate op_planning afterward (run this patch, or fold it in), or Order
-- Planning breaks again the same way.
-- ============================================================================

drop materialized view if exists op_planning cascade;

create materialized view op_planning as
with stock as (
  select branch_code, item_name, sum(closing_qty) as closing_qty
  from item_stock_ledger_mat
  group by branch_code, item_name
),
in_transit as (
  select destination_branch_code as branch_code,
         upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
         sum(quantity) as in_transit_qty
  from sales_transactions
  where order_type = 'BRANCH-TRANSFER'
    and status = 'IN_TRANSIT'
    and destination_branch_code is not null
    and doc_date >= current_date - 45
  group by 1, 2
),
attrs as (
  select distinct on (branch_code, item_name)
         branch_code, item_name, thickness, color_name, old_code
  from op_sales_norm
  order by branch_code, item_name, doc_date desc
),
ageing as (
  select branch_code, item_name,
    coalesce(sum(quantity) filter (where doc_date >  current_date - 30), 0) as d01_30,
    coalesce(sum(quantity) filter (where doc_date <= current_date - 30  and doc_date > current_date - 60),  0) as d31_60,
    coalesce(sum(quantity) filter (where doc_date <= current_date - 60  and doc_date > current_date - 90),  0) as d61_90,
    coalesce(sum(quantity) filter (where doc_date <= current_date - 90  and doc_date > current_date - 120), 0) as d91_120
  from op_sales_norm
  group by branch_code, item_name
)
select
  b.branch_code,
  b.family,
  b.variant,
  b.size,
  b.item_name,
  a.thickness,
  a.color_name,
  a.old_code,
  coalesce(ag.d91_120, 0) as d91_120,
  coalesce(ag.d61_90, 0)  as d61_90,
  coalesce(ag.d31_60, 0)  as d31_60,
  coalesce(ag.d01_30, 0)  as d01_30,
  b.total_qty             as branch_sales_qty,
  b.branch_grade,
  n.n_rating,
  n.n_grade,
  coalesce(s.closing_qty, 0)     as current_stock,
  coalesce(it.in_transit_qty, 0) as in_transit
from op_branch_grade b
left join op_national_rating n on n.n_id = b.family || '-' || b.variant
left join stock      s  on s.branch_code  = b.branch_code and s.item_name  = b.item_name
left join in_transit it on it.branch_code = b.branch_code and it.item_name = b.item_name
left join attrs      a  on a.branch_code  = b.branch_code and a.item_name  = b.item_name
left join ageing    ag on ag.branch_code = b.branch_code and ag.item_name = b.item_name;

create unique index if not exists op_planning_key on op_planning (branch_code, item_name);
create index if not exists op_planning_branch on op_planning (branch_code);

grant select on op_planning to anon, authenticated, service_role;

-- Refresh the whole order-planning chain so the screen populates immediately.
select refresh_order_planning();
