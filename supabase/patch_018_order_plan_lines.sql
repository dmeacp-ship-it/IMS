-- ============================================================================
-- Virgo ACP IMS — patch_018_order_plan_lines.sql
-- Manual order-entry fields for the Order Planning worksheet (the editable
-- columns of the ACP sheet): Actual Order, Branch Remarks, Appvd Order,
-- Factory Remark, Batch. One row per branch + item, upserted as users type.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists order_plan_lines (
  id bigint generated always as identity primary key,
  branch_code    text not null references branches(code),
  item_name      text not null,
  actual_order   numeric,
  branch_remarks text,
  approved_order numeric,
  factory_remark text,
  batch          text,
  updated_by     uuid references user_profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (branch_code, item_name)
);

create index if not exists order_plan_lines_branch on order_plan_lines (branch_code);
