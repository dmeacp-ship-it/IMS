-- ============================================================================
-- Virgo ACP IMS — patch_015_materialized_ledger.sql
-- Precompute item_stock_ledger as a MATERIALIZED view so the heavy read
-- endpoints (admin all-branches ledger, variance report) no longer recompute a
-- 20k-row CTE ~21x per request and blow past Vercel Hobby's 10-second function
-- limit (which was producing 504 Gateway Timeouts).
--
-- The expensive computation now runs INSIDE Postgres on a schedule (pg_cron),
-- where Vercel's time limit does not apply. The serverless functions only read
-- the precomputed snapshot, which is a cheap indexed scan.
--
-- Trade-off: item_stock_ledger_mat is a snapshot, at most REFRESH_INTERVAL
-- stale (default 15 min). Single-branch reads still use the live view for
-- exactness (see lib/data.js getItemLedger).
--
-- Idempotent: safe to re-run. Depends on the item_stock_ledger view from
-- patch_014 (or later).
-- ============================================================================

-- 1. Materialized snapshot of the existing (live) view.
drop materialized view if exists item_stock_ledger_mat cascade;
create materialized view item_stock_ledger_mat as
  select * from item_stock_ledger;

-- 2. Unique index — required for REFRESH ... CONCURRENTLY (which avoids locking
--    readers during a refresh). batch may be NULL, so coalesce it in the key.
create unique index if not exists item_stock_ledger_mat_key
  on item_stock_ledger_mat (branch_code, item_name, coalesce(batch, ''));

-- Secondary index for branch-scoped reads (HOD / branch variance).
create index if not exists item_stock_ledger_mat_branch
  on item_stock_ledger_mat (branch_code);

-- 3. Grants so the app roles can read it.
grant select on item_stock_ledger_mat to anon, authenticated, service_role;

-- 4. Refresh helper, callable from the app via supabase.rpc if ever needed.
create or replace function refresh_item_stock_ledger()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently item_stock_ledger_mat;
end;
$$;

grant execute on function refresh_item_stock_ledger() to anon, authenticated, service_role;

-- 5. Keep the snapshot fresh from inside the database — no Vercel time limit
--    applies here. Requires the pg_cron extension. If the CREATE EXTENSION line
--    errors, enable pg_cron once via the Supabase dashboard
--    (Database > Extensions > search "pg_cron" > enable), then re-run from here.
create extension if not exists pg_cron;

-- Drop any previous copy of the job before (re)scheduling — makes this re-runnable.
select cron.unschedule('refresh_item_stock_ledger')
where exists (select 1 from cron.job where jobname = 'refresh_item_stock_ledger');

-- Refresh every 15 minutes. Lower the interval (e.g. '*/5 * * * *') for fresher
-- reports, at the cost of more frequent recomputation on the database.
select cron.schedule(
  'refresh_item_stock_ledger',
  '*/15 * * * *',
  $$select refresh_item_stock_ledger();$$
);
