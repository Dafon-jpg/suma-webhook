-- ============================================================================
-- SUMA — Migration 002: Subscription columns
-- Run this in the Supabase SQL Editor
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_subscribed         BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_end_date TIMESTAMPTZ DEFAULT NULL;

-- Add a comment for documentation
COMMENT ON COLUMN users.is_subscribed IS 'Whether the user has an active subscription';
COMMENT ON COLUMN users.subscription_end_date IS 'When the subscription expires (NULL = no expiry)';
