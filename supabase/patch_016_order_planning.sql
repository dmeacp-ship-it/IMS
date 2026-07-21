-- ============================================================================
-- Virgo ACP IMS — patch_016_order_planning.sql
-- "Order Planning" — reproduces the Google-Sheet grading system inside the IMS,
-- computed directly from sales_transactions (no separate spreadsheet pipeline).
--
-- Two independent ratings, mirroring the original Apps Script logic exactly:
--
--   NATIONAL rating (per item = family+variant, ALL branches, all-time)
--     score = customers*0.4 + times*0.3 + frequency*0.3   (quantity IGNORED)
--       customers : >50→10 >40→8 >30→6 >20→4 else 2
--       times     : >200→10 >100→8 >50→6 >25→4 else 2   (count of sale lines)
--       frequency : ≤3→10 ≤6→8 ≤15→6 ≤25→4 else 2        (avg days between
--                    distinct sale dates; one date → 365)
--       label     : ≥9 A+  ≥7 A  ≥5 B  ≥3 C  else D
--
--   BRANCH grade (per branch + item + size)
--     Pareto by quantity share WITHIN each branch × product-family:
--       cumulative share  ≤22 A1  ≤43 A2  ≤55 B1  ≤70 B2  ≤85 C  else D
--       family not in the 5 core families → CUS ; family with 0 sales → D
--
-- Only CUSTOMER ORDER rows count as demand (branch transfers are internal moves).
-- Item family/variant/size are parsed from item_description (FAMILY-VARIANT-SIZE,
-- e.g. "ALFA3030-VL911-3660X1220"), matching how the ledger normalizes names.
--
-- Idempotent: safe to re-run. Heavy aggregations are materialized and refreshed
-- by pg_cron so read endpoints stay under Vercel Hobby's 10s limit.
-- ============================================================================

-- Core product families that get a real A1..D grade; everything else is CUS.
-- (Mirrors allowedCodes in NewBranchGrade3.)
-- Kept inline in the views below so this file is self-contained.

-- --------------------------------------------------------------------------
-- 0. Normalized customer-sales feed (demand only).
-- --------------------------------------------------------------------------
drop view if exists op_sales_norm cascade;
create view op_sales_norm as
select
  source_branch_code as branch_code,
  doc_date,
  customer_code,
  quantity,
  upper(trim(regexp_replace(item_description, '^\s*VIRGO\s+', '', 'i'))) as item_name
from sales_transactions
where order_type = 'CUSTOMER ORDER'
  and source_branch_code is not null
  and item_description is not null
  and quantity is not null;

-- --------------------------------------------------------------------------
-- 1. NATIONAL rating — materialized (per family+variant, all branches).
-- --------------------------------------------------------------------------
drop materialized view if exists op_national_rating cascade;
create materialized view op_national_rating as
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
dates as (
  select distinct n_id, doc_date from keyed
),
gaps as (
  select n_id,
         (doc_date - lag(doc_date) over (partition by n_id order by doc_date)) as gap
  from dates
),
freq as (
  select n_id, avg(gap)::numeric as avg_freq
  from gaps
  group by n_id
),
scored as (
  select a.n_id, a.family, a.variant, a.total_qty, a.customers, a.times,
         coalesce(f.avg_freq, 365) as avg_freq,
         (case when a.customers > 50 then 10 when a.customers > 40 then 8
               when a.customers > 30 then 6 when a.customers > 20 then 4 else 2 end) as cust_score,
         (case when a.times > 200 then 10 when a.times > 100 then 8
               when a.times > 50 then 6  when a.times > 25 then 4 else 2 end) as times_score,
         (case when coalesce(f.avg_freq,365) > 0 and coalesce(f.avg_freq,365) <= 3 then 10
               when coalesce(f.avg_freq,365) <= 6  then 8
               when coalesce(f.avg_freq,365) <= 15 then 6
               when coalesce(f.avg_freq,365) <= 25 then 4 else 2 end) as freq_score
  from agg a
  left join freq f using (n_id)
)
select
  n_id, family, variant, total_qty, customers, times, round(avg_freq, 2) as avg_freq,
  round((cust_score * 0.4 + times_score * 0.3 + freq_score * 0.3)::numeric, 1) as n_rating,
  (case
     when (cust_score * 0.4 + times_score * 0.3 + freq_score * 0.3) >= 9 then 'A+'
     when (cust_score * 0.4 + times_score * 0.3 + freq_score * 0.3) >= 7 then 'A'
     when (cust_score * 0.4 + times_score * 0.3 + freq_score * 0.3) >= 5 then 'B'
     when (cust_score * 0.4 + times_score * 0.3 + freq_score * 0.3) >= 3 then 'C'
     else 'D' end) as n_grade
from scored;

create unique index if not exists op_national_rating_key on op_national_rating (n_id);

-- --------------------------------------------------------------------------
-- 2. BRANCH grade — materialized (per branch + item + size).
-- --------------------------------------------------------------------------
drop materialized view if exists op_branch_grade cascade;
create materialized view op_branch_grade as
with base as (
  -- Branch grade reflects the recent TREND: only the last 6 months of sales,
  -- anchored to the latest sale date in the data (robust to a lagging sync).
  select
    branch_code,
    split_part(item_name, '-', 1) as family,
    split_part(item_name, '-', 2) as variant,
    split_part(item_name, '-', 3) as size,
    item_name,
    quantity
  from op_sales_norm
  where doc_date >= (select max(doc_date) from op_sales_norm) - interval '6 months'
),
agg as (
  select branch_code, family, variant, size, item_name,
         sum(quantity) as total_qty
  from base
  group by branch_code, family, variant, size, item_name
),
ranked as (
  select *,
    sum(total_qty) over (partition by branch_code, family) as family_total,
    sum(total_qty) over (
      partition by branch_code, family
      order by total_qty desc, item_name
      rows between unbounded preceding and current row
    ) as cum_qty
  from agg
)
select
  branch_code, family, variant, size, item_name, total_qty, family_total,
  (case when family_total > 0 then round((cum_qty / family_total)::numeric, 4) else 0 end) as cum_share,
  (case
     when family not in ('ALFA3030','SLEEK3025','CROMA3020','ALFA6030','ALFA4030') then 'CUS'
     when family_total = 0 then 'D'
     when cum_qty / family_total <= 0.22 then 'A1'
     when cum_qty / family_total <= 0.43 then 'A2'
     when cum_qty / family_total <= 0.55 then 'B1'
     when cum_qty / family_total <= 0.70 then 'B2'
     when cum_qty / family_total <= 0.85 then 'C'
     else 'D' end) as branch_grade
from ranked;

create unique index if not exists op_branch_grade_key on op_branch_grade (branch_code, item_name);
create index if not exists op_branch_grade_branch on op_branch_grade (branch_code);

-- --------------------------------------------------------------------------
-- 3. Planning snapshot — joins branch grade + national rating + current stock.
--    Materialized so paged reads are a cheap indexed scan (the stock roll-up
--    over the ledger runs once at refresh, not per page).
-- --------------------------------------------------------------------------
drop materialized view if exists op_planning cascade;
create materialized view op_planning as
with stock as (
  select branch_code, item_name, sum(closing_qty) as closing_qty
  from item_stock_ledger_mat
  group by branch_code, item_name
)
select
  b.branch_code,
  b.family,
  b.variant,
  b.size,
  b.item_name,
  b.total_qty         as branch_sales_qty,
  b.branch_grade,
  n.n_rating,
  n.n_grade,
  coalesce(s.closing_qty, 0) as current_stock
from op_branch_grade b
left join op_national_rating n on n.n_id = b.family || '-' || b.variant
left join stock s on s.branch_code = b.branch_code and s.item_name = b.item_name;

create unique index if not exists op_planning_key on op_planning (branch_code, item_name);
create index if not exists op_planning_branch on op_planning (branch_code);

-- --------------------------------------------------------------------------
-- 4. Grants.
-- --------------------------------------------------------------------------
grant select on op_national_rating, op_branch_grade, op_planning to anon, authenticated, service_role;
grant select on op_sales_norm to anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 5. Refresh helper + schedule (heavy work runs inside Postgres, not Vercel).
-- --------------------------------------------------------------------------
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

create extension if not exists pg_cron;

select cron.unschedule('refresh_order_planning')
where exists (select 1 from cron.job where jobname = 'refresh_order_planning');

-- Rebuild the planning ratings every 3 hours (after new sales sync in).
select cron.schedule('refresh_order_planning', '0 */3 * * *',
  $$select refresh_order_planning();$$);
