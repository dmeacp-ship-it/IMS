-- ============================================================================
-- Virgo ACP IMS — patch_005_settings.sql
-- Creates the app_settings table to store global settings like the Google
-- Spreadsheet ID.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- Seed default empty value for sheet id
INSERT INTO app_settings (key, value)
VALUES ('google_spreadsheet_id', '')
ON CONFLICT (key) DO NOTHING;
