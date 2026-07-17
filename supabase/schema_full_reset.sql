-- ============================================================================
-- Virgo ACP IMS — full schema. Idempotent: safe to re-run from scratch
-- regardless of what's currently in the database (drops everything this
-- app owns first, then rebuilds it). Combines the original auth/transfer
-- schema with the item+batch stock ledger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Clean slate — drop anything from a previous (possibly partial) run.
-- CASCADE also drops the foreign keys / trigger / view that depend on these.
-- ---------------------------------------------------------------------------
drop view if exists item_stock_ledger cascade;
drop view if exists stock_ledger cascade;
drop table if exists stock_conversions cascade;
drop table if exists opening_stock cascade;
drop table if exists sales_transactions cascade;
drop table if exists hod_branch_assignments cascade;
drop table if exists user_profiles cascade;
drop table if exists branches cascade;
drop function if exists set_default_transfer_status() cascade;

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
create table branches (
  code text primary key,
  name text not null,
  facility_type text not null check (facility_type in ('BRANCH', 'FACTORY')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Users / auth (custom auth — see lib/auth.js, not Supabase Auth)
-- ---------------------------------------------------------------------------
create table user_profiles (
  id uuid primary key default gen_random_uuid(),
  email text,
  username text not null unique,
  password_hash text not null,
  full_name text,
  role text not null check (role in ('SUPER_ADMIN', 'ADMIN', 'BRANCH', 'HOD')),
  branch_code text references branches(code),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table hod_branch_assignments (
  hod_user_id uuid not null references user_profiles(id) on delete cascade,
  branch_code text not null references branches(code) on delete cascade,
  primary key (hod_user_id, branch_code)
);

-- ---------------------------------------------------------------------------
-- Sales transactions — synced from the central RAW_DATA sheet (Part A)
-- ---------------------------------------------------------------------------
create table sales_transactions (
  id bigint generated always as identity primary key,
  docnum text not null,
  bill_no text,
  doc_date date not null,
  bill_date date,
  customer_code text,
  customer_name text,
  item_code text not null,
  item_description text,
  batch text not null default '',
  hsn text,
  thickness text,
  thickness_type text,
  size text,
  finish text,
  brand text,
  gst_rate numeric,
  quantity numeric not null,
  customer_gstin text,
  net_revenue numeric,
  cgst_amt numeric,
  sgst_amt numeric,
  igst_amt numeric,
  revenue_with_gst numeric,
  doc_total numeric,
  wt_amount numeric,
  unit_of_packg text,
  total_sqm numeric,
  rate_per_sqm numeric,
  source_branch_code text references branches(code),
  order_type text not null check (order_type in ('BRANCH-TRANSFER', 'CUSTOMER ORDER')),
  destination_branch_code text references branches(code),
  status text check (status in ('IN_TRANSIT', 'RECEIVED')),
  received_at timestamptz,
  received_by uuid references user_profiles(id),
  synced_at timestamptz not null default now(),
  unique (docnum, item_code, batch)
);

create index idx_sales_txn_source on sales_transactions(source_branch_code);
create index idx_sales_txn_dest on sales_transactions(destination_branch_code);
create index idx_sales_txn_status on sales_transactions(status);
create index idx_sales_txn_doc_date on sales_transactions(doc_date);
create index idx_sales_txn_item_batch on sales_transactions(item_code, batch);

-- Auto-default new branch-transfer rows to IN_TRANSIT
create or replace function set_default_transfer_status()
returns trigger as $$
begin
  if new.order_type = 'BRANCH-TRANSFER' and new.status is null then
    new.status := 'IN_TRANSIT';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_default_transfer_status
before insert on sales_transactions
for each row execute function set_default_transfer_status();

-- ---------------------------------------------------------------------------
-- Item + batch stock ledger
-- ---------------------------------------------------------------------------

-- Opening balance per branch + item + batch. Upserted, not appended —
-- re-entering the same branch+item+batch corrects the value and as_of_date.
create table opening_stock (
  branch_code text not null references branches(code),
  item_code   text not null,
  batch       text not null default '',
  quantity    numeric not null default 0,
  as_of_date  date not null,
  updated_by  uuid references user_profiles(id),
  updated_at  timestamptz not null default now(),
  primary key (branch_code, item_code, batch)
);

-- Manual "cutting" / conversion events: one batch consumed, one new batch
-- produced, at a single branch. Not tied to any SAP document.
create table stock_conversions (
  id              bigint generated always as identity primary key,
  branch_code     text not null references branches(code),
  from_item_code  text not null,
  from_batch      text not null default '',
  from_quantity   numeric not null check (from_quantity > 0),
  to_item_code    text not null,
  to_batch        text not null default '',
  to_quantity     numeric not null check (to_quantity > 0),
  notes           text,
  created_by      uuid references user_profiles(id),
  created_at      timestamptz not null default now()
);

create index idx_stock_conv_branch on stock_conversions(branch_code);
create index idx_stock_conv_from on stock_conversions(branch_code, from_item_code, from_batch);
create index idx_stock_conv_to on stock_conversions(branch_code, to_item_code, to_batch);

-- Item-level running ledger: opening + received-transfers-in + conversions-in
-- minus dispatched-out (sales + transfers, deducted immediately on sync,
-- regardless of received status) minus conversions-out.
create or replace view item_stock_ledger as
with outward as (
  select source_branch_code as branch_code, item_code, batch, sum(quantity) as qty
  from sales_transactions
  where source_branch_code is not null
  group by source_branch_code, item_code, batch
),
inward_transfer as (
  select destination_branch_code as branch_code, item_code, batch, sum(quantity) as qty
  from sales_transactions
  where order_type = 'BRANCH-TRANSFER' and status = 'RECEIVED' and destination_branch_code is not null
  group by destination_branch_code, item_code, batch
),
conv_out as (
  select branch_code, from_item_code as item_code, from_batch as batch, sum(from_quantity) as qty
  from stock_conversions
  group by branch_code, from_item_code, from_batch
),
conv_in as (
  select branch_code, to_item_code as item_code, to_batch as batch, sum(to_quantity) as qty
  from stock_conversions
  group by branch_code, to_item_code, to_batch
),
latest_desc as (
  select distinct on (item_code) item_code, item_description
  from sales_transactions
  order by item_code, doc_date desc
),
keys as (
  select branch_code, item_code, batch from opening_stock
  union select branch_code, item_code, batch from outward
  union select branch_code, item_code, batch from inward_transfer
  union select branch_code, item_code, batch from conv_out
  union select branch_code, item_code, batch from conv_in
)
select
  k.branch_code,
  k.item_code,
  coalesce(ld.item_description, k.item_code) as item_description,
  k.batch,
  coalesce(os.quantity, 0) as opening_qty,
  coalesce(it.qty, 0) + coalesce(ci.qty, 0) as inward_qty,
  coalesce(o.qty, 0) + coalesce(co.qty, 0) as outward_qty,
  coalesce(os.quantity, 0) + coalesce(it.qty, 0) + coalesce(ci.qty, 0)
    - coalesce(o.qty, 0) - coalesce(co.qty, 0) as closing_qty,
  os.as_of_date as opening_as_of_date
from keys k
left join opening_stock   os on os.branch_code = k.branch_code and os.item_code = k.item_code and os.batch = k.batch
left join outward         o  on o.branch_code  = k.branch_code and o.item_code  = k.item_code and o.batch  = k.batch
left join inward_transfer it on it.branch_code = k.branch_code and it.item_code = k.item_code and it.batch = k.batch
left join conv_out        co on co.branch_code = k.branch_code and co.item_code = k.item_code and co.batch = k.batch
left join conv_in         ci on ci.branch_code = k.branch_code and ci.item_code = k.item_code and ci.batch = k.batch
left join latest_desc     ld on ld.item_code   = k.item_code;

-- ---------------------------------------------------------------------------
-- Seed the 17 branches (names must match BRANCH_NAME exactly in your sheet —
-- edit these if your sheet's spelling/spacing differs; the sync script
-- normalizes case/spacing/punctuation before comparing, so minor formatting
-- differences are tolerated, but the underlying words must match).
-- ---------------------------------------------------------------------------
insert into branches (code, name, facility_type) values
  ('AHMEDABAD-FACTORY', 'Ahmedabad- ACP Industries Depot', 'FACTORY'),
  ('BANGALORE-BRANCH',  'Bangalore - ACP Industries Depot', 'BRANCH'),
  ('CHENNAI-BRANCH',    'Chennai - ACP Industries Depot', 'BRANCH'),
  ('DELHI-BRANCH',      'Delhi - ACP Industries Depot', 'BRANCH'),
  ('GUJRAT-BRANCH',     'Gujrat (Ahmedabad)- ACP Industreis Depot-Branch', 'BRANCH'),
  ('GUWAHATI-BRANCH',   'Guwahati- ACP Industries Depot', 'BRANCH'),
  ('HYDERABAD-BRANCH',  'Hyderabad - ACP Industries Depot', 'BRANCH'),
  ('INDORE-BRANCH',     'Indore- ACP Industries Depot', 'BRANCH'),
  ('JAIPUR-BRANCH',     'Jaipur - ACP Industries Depot', 'BRANCH'),
  ('KOCHI-BRANCH',      'Kochi - ACP Industries Depot', 'BRANCH'),
  ('KOLKATA-BRANCH',    'Kolkata - ACP Industries Depot', 'BRANCH'),
  ('LUCKNOW-BRANCH',    'Lucknow- ACP Industries Depot', 'BRANCH'),
  ('MUMBAI-BRANCH',     'Mumbai - ACP Industries Depot', 'BRANCH'),
  ('PANCHKULA-BRANCH',  'Panchkula - ACP Industries Depot', 'BRANCH'),
  ('PATNA-BRANCH',      'Patna- ACP Industries Depot', 'BRANCH'),
  ('RAIPUR-BRANCH',     'Raipur- ACP Industries Depot', 'BRANCH'),
  ('RANCHI-BRANCH',     'Ranchi - ACP Industries Depot', 'BRANCH');
