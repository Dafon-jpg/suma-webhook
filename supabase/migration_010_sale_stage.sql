-- ============================================================================
-- SUMA — Migration 010: Sales funnel stage tracking
--
-- Adds sale_stage and sale_attempts to the users table to support
-- the in-WhatsApp subscription sales flow.
--
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
-- ============================================================================

-- Current stage in the sales funnel
ALTER TABLE users ADD COLUMN IF NOT EXISTS sale_stage TEXT DEFAULT NULL;
COMMENT ON COLUMN users.sale_stage IS 'Sales funnel stage: pitch_sent, info_sent, capturing_name, capturing_email, awaiting_payment, declined, declined_final';

-- Number of times the pitch has been shown (max 2)
ALTER TABLE users ADD COLUMN IF NOT EXISTS sale_attempts INT DEFAULT 0;
COMMENT ON COLUMN users.sale_attempts IS 'Number of times the sales pitch has been shown. Max 2 proactive attempts.';
