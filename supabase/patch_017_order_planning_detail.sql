-- ============================================================================
-- Virgo ACP IMS — patch_017_order_planning_detail.sql
-- Extends Order Planning to the full ACP worksheet columns: item attributes
-- (thickness, colour, old code), 30-day ageing sales slabs, and in-transit
-- stock alongside closing stock. Supersedes the op_planning shape in patch_016.
--
-- Derived columns computed in the UI from these: 4m avg sale, avg req,
-- order %, gross req, actual req (see public/app.js).
--
-- Idempotent: safe to re-run. Requires patch_016 (national/branch views) and
-- patch_015 (ledger matview) already applied.
-- ============================================================================

-- 1. Add item attributes to the normalized sales feed. Appending columns at the
--    end keeps CREATE OR REPLACE valid, so dependent matviews are NOT dropped.
create or replace view op_sales_norm as
select
  source_branch_code as branch_code,
  doc_date,
  customer_code,
  quantity,
  upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name,
  thickness,
  finish   as color_name,
  item_code as old_code
from sales_transactions
where order_type = 'CUSTOMER ORDER'
  and source_branch_code is not null
  and item_description is not null
  and quantity is not null;

-- 2. Rebuild the planning snapshot with the full ACP column set.
drop materialized view if exists op_planning cascade;
create materialized view op_planning as
with stock as (
  select branch_code, item_name,
         sum(closing_qty)    as closing_qty,
         sum(in_transit_qty) as in_transit_qty
  from item_stock_ledger_mat
  group by branch_code, item_name
),
-- One representative attribute row per branch+item (latest sale wins).
attrs as (
  select distinct on (branch_code, item_name)
         branch_code, item_name, thickness, color_name, old_code
  from op_sales_norm
  order by branch_code, item_name, doc_date desc
),
-- 30-day ageing slabs, measured back from today.
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
  coalesce(s.closing_qty, 0)    as current_stock,
  coalesce(s.in_transit_qty, 0) as in_transit
from op_branch_grade b
left join op_national_rating n on n.n_id = b.family || '-' || b.variant
left join stock  s  on s.branch_code  = b.branch_code and s.item_name  = b.item_name
left join attrs  a  on a.branch_code  = b.branch_code and a.item_name  = b.item_name
left join ageing ag on ag.branch_code = b.branch_code and ag.item_name = b.item_name;

create unique index if not exists op_planning_key on op_planning (branch_code, item_name);
create index if not exists op_planning_branch on op_planning (branch_code);

grant select on op_planning to anon, authenticated, service_role;

-- refresh_order_planning() from patch_016 still refreshes op_planning by name.
