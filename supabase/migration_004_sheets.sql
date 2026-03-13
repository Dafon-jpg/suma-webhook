-- ============================================================================
-- SUMA — Migration 003: Google Sheets integration columns
-- Run this in the Supabase SQL Editor
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email            TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spreadsheet_id   TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spreadsheet_url  TEXT DEFAULT NULL;

COMMENT ON COLUMN users.email IS 'User email for Google Sheets sharing';
COMMENT ON COLUMN users.spreadsheet_id IS 'Google Sheets spreadsheet ID (created on subscription)';
COMMENT ON COLUMN users.spreadsheet_url IS 'Public web view URL of the spreadsheet';
