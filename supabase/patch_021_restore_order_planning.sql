-- ============================================================================
-- Virgo ACP IMS — patch_021_restore_order_planning.sql
-- Restores and refreshes the op_planning materialized view that was cascade-dropped
-- when item_stock_ledger_mat was rebuilt in patch 020.
-- ============================================================================

-- 1. Ensure op_sales_norm view exists
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

-- 2. Rebuild op_national_rating if not present
create materialized view if not exists op_national_rating as
with keyed as (
  select
    split_part(item_name, '-', 1) as family,
    split_part(item_name, '-', 2) as variant,
    split_part(item_name, '-', 1) || '-' || split_part(item_name, '-', 2) as n_id,
    customer_code, doc_date, quantity
  from op_sales_norm
),
agg as (
  select n_id, family, variant,
         sum(quantity)                as total_qty,
         count(distinct customer_code) as customers,
         count(*)                     as times
  from keyed
  group by n_id, family, variant
),
days_calc as (
  select n_id,
         count(distinct doc_date) as distinct_dates,
         max(doc_date) - min(doc_date) as day_span
  from keyed
  group by n_id
),
freq_calc as (
  select n_id,
         case when distinct_dates <= 1 then 365.0
              else (day_span::numeric / (distinct_dates - 1)) end as avg_freq
  from days_calc
),
scored as (
  select a.n_id, a.family, a.variant, a.total_qty, a.customers, a.times, f.avg_freq,
    (case when a.customers > 50 then 10 when a.customers > 40 then 8 when a.customers > 30 then 6 when a.customers > 20 then 4 else 2 end) as s_cust,
    (case when a.times > 200 then 10 when a.times > 100 then 8 when a.times > 50 then 6 when a.times > 25 then 4 else 2 end) as s_times,
    (case when f.avg_freq <= 3 then 10 when f.avg_freq <= 6 then 8 when f.avg_freq <= 15 then 6 when f.avg_freq <= 25 then 4 else 2 end) as s_freq
  from agg a
  join freq_calc f using (n_id)
)
select n_id, family, variant, total_qty, customers, times, avg_freq,
  (s_cust * 0.4 + s_times * 0.3 + s_freq * 0.3)::numeric(5,2) as n_rating,
  (case when (s_cust * 0.4 + s_times * 0.3 + s_freq * 0.3) >= 9 then 'A+'
        when (s_cust * 0.4 + s_times * 0.3 + s_freq * 0.3) >= 7 then 'A'
        when (s_cust * 0.4 + s_times * 0.3 + s_freq * 0.3) >= 5 then 'B'
        when (s_cust * 0.4 + s_times * 0.3 + s_freq * 0.3) >= 3 then 'C'
        else 'D' end) as n_grade
from scored;

create unique index if not exists op_national_rating_key on op_national_rating (n_id);

-- 3. Rebuild op_branch_grade if not present
create materialized view if not exists op_branch_grade as
with item_parsed as (
  select branch_code, item_name,
    split_part(item_name, '-', 1) as family,
    split_part(item_name, '-', 2) as variant,
    split_part(item_name, '-', 3) as size,
    sum(quantity) as qty
  from op_sales_norm
  group by branch_code, item_name
),
fam_totals as (
  select branch_code, family, sum(qty) as family_total
  from item_parsed
  group by branch_code, family
),
ranked as (
  select ip.branch_code, ip.item_name, ip.family, ip.variant, ip.size, ip.qty as total_qty,
         ft.family_total,
         sum(ip.qty) over (
           partition by ip.branch_code, ip.family
           order by ip.qty desc, ip.item_name asc
         ) as cum_qty
  from item_parsed ip
  join fam_totals ft on ft.branch_code = ip.branch_code and ft.family = ip.family
)
select branch_code, item_name, family, variant, size, total_qty, family_total, cum_qty,
  (case
     when family not in ('ALFA3030', 'ALFA4030', 'ALFAFR', 'FR3030', 'FR4030') then 'CUS'
     when family_total = 0 then 'D'
     when cum_qty / family_total <= 0.22 then 'A1'
     when cum_qty / family_total <= 0.43 then 'A2'
     when cum_qty / family_total <= 0.55 then 'B1'
     when cum_qty / family_total <= 0.70 then 'B2'
     when cum_qty / family_total <= 0.85 then 'C'
     else 'D' end) as branch_grade
from ranked;

create unique index if not exists op_branch_grade_key on op_branch_grade (branch_code, item_name);

-- 4. Rebuild op_planning materialized view
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

grant select on op_national_rating, op_branch_grade, op_planning to anon, authenticated, service_role;

-- 5. Helper function to refresh order planning materialized views
create or replace function refresh_order_planning()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view op_national_rating;
  refresh materialized view op_branch_grade;
  refresh materialized view op_planning;
end;
$$;

grant execute on function refresh_order_planning() to anon, authenticated, service_role;

-- Execute initial refresh
select refresh_order_planning();
