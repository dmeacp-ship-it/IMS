-- ============================================================================
-- Virgo ACP IMS — patch_026_login_attempts.sql
--
-- Durable login rate-limiting. The in-memory limiter in lib/auth.js only holds
-- state while a single serverless instance stays warm, so lockout is bypassable
-- across cold starts / parallel instances. This table persists failed-attempt
-- counts so the 5-strikes/15-minute lockout actually holds on Vercel.
--
-- Safe to run any time. lib/auth.js uses this table when present and silently
-- falls back to the in-memory limiter if it is missing, so deploying the code
-- before running this patch does not break login.
-- ============================================================================

create table if not exists login_attempts (
  username     text primary key,
  attempts     integer     not null default 0,
  last_attempt timestamptz not null default now()
);

grant select, insert, update, delete on login_attempts to service_role;
