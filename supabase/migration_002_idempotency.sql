-- ============================================================================
-- SUMA — Migration 002: Idempotency Layer
-- Prevents duplicate message processing from Meta webhook retries.
--
-- Run in Supabase SQL Editor AFTER migration_001_init.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS processed_messages (
  wamid       TEXT PRIMARY KEY,               -- WhatsApp message ID (e.g. "wamid.HBgL...")
  user_phone  TEXT NOT NULL,                   -- For debugging/auditing
  received_at TIMESTAMPTZ DEFAULT now(),       -- When we first saw it
  processed   BOOLEAN DEFAULT FALSE,           -- TRUE once pipeline completes
  error       TEXT                             -- Last error if processing failed
);

-- TTL cleanup: auto-delete records older than 7 days (saves storage)
-- Run this as a Supabase pg_cron job or scheduled function:
--   SELECT cron.schedule('cleanup-processed-messages', '0 3 * * *',
--     $$DELETE FROM processed_messages WHERE received_at < now() - interval '7 days'$$
--   );

-- Index for the TTL cleanup query
CREATE INDEX IF NOT EXISTS idx_processed_messages_received_at
  ON processed_messages(received_at);

COMMENT ON TABLE processed_messages IS 
  'Idempotency guard: stores WhatsApp message IDs to prevent duplicate processing on webhook retries.';
