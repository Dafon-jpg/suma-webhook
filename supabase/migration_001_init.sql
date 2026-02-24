-- ============================================================================
-- SUMA — Database Schema
-- Run this in the Supabase SQL Editor (or as a migration)
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------
-- Users table
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       TEXT UNIQUE NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Index for fast lookup by phone
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- -----------------------------------------------
-- Categories table
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT UNIQUE NOT NULL,
  icon        TEXT,          -- optional emoji/icon
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Seed default categories
INSERT INTO categories (name, icon) VALUES
  ('comida',          '🍕'),
  ('transporte',      '🚗'),
  ('supermercado',    '🛒'),
  ('entretenimiento', '🎬'),
  ('salud',           '💊'),
  ('educacion',       '📚'),
  ('servicios',       '💡'),
  ('ropa',            '👕'),
  ('otros',           '📦')
ON CONFLICT (name) DO NOTHING;

-- -----------------------------------------------
-- Expenses table
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  description   TEXT NOT NULL,
  category_id   UUID NOT NULL REFERENCES categories(id),
  raw_message   TEXT,           -- original WhatsApp message (for ML/analysis)
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Composite index for user queries (monthly summaries, etc.)
CREATE INDEX IF NOT EXISTS idx_expenses_user_date
  ON expenses(user_id, created_at DESC);

-- Index for category-based analysis
CREATE INDEX IF NOT EXISTS idx_expenses_category
  ON expenses(category_id);

-- -----------------------------------------------
-- Useful views for data analysis
-- -----------------------------------------------

-- Monthly summary per user
CREATE OR REPLACE VIEW v_monthly_summary AS
SELECT
  e.user_id,
  u.phone,
  DATE_TRUNC('month', e.created_at) AS month,
  c.name AS category,
  COUNT(*)                           AS transaction_count,
  SUM(e.amount)                      AS total_amount,
  AVG(e.amount)                      AS avg_amount
FROM expenses e
JOIN users u      ON u.id = e.user_id
JOIN categories c ON c.id = e.category_id
GROUP BY e.user_id, u.phone, DATE_TRUNC('month', e.created_at), c.name;

-- Daily totals per user
CREATE OR REPLACE VIEW v_daily_totals AS
SELECT
  e.user_id,
  DATE(e.created_at) AS day,
  SUM(e.amount)       AS total_amount,
  COUNT(*)            AS transaction_count
FROM expenses e
GROUP BY e.user_id, DATE(e.created_at);

-- -----------------------------------------------
-- Row Level Security (optional but recommended)
-- -----------------------------------------------
-- Uncomment these if you want to use RLS with user tokens later:
--
-- ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "Users can read own expenses"
--   ON expenses FOR SELECT
--   USING (user_id = auth.uid());
