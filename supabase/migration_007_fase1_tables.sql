-- ============================================================================
-- SUMA — Migration 007: Tablas de Fase 1
--
-- Crea las tablas necesarias para:
--   - chat_sessions: historial conversacional (memoria de corto plazo)
--   - pending_confirmations: confirmaciones pendientes del usuario
--   - subscriptions: suscripciones recurrentes del usuario
--
-- También:
--   - Agrega deleted_at a transactions (soft delete / undo)
--   - Agrega user_id a categories (categorías personalizadas)
--   - Reemplaza el UNIQUE de categories.name por índices parciales
--   - Seed de categorías de ingreso globales
--
-- IMPORTANTE: Correr en Supabase SQL Editor como una transacción.
-- ============================================================================

BEGIN;

-- -----------------------------------------------
-- 1. Tabla chat_sessions (historial conversacional)
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS chat_sessions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user
  ON chat_sessions(user_id, created_at DESC);

-- -----------------------------------------------
-- 2. Tabla pending_confirmations
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_data  JSONB NOT NULL,
  confirmation_type TEXT NOT NULL CHECK (confirmation_type IN ('transaction', 'subscription')),
  field_editing     TEXT,          -- campo siendo corregido (null = espera sí/no)
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '10 minutes'),
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_conf_user
  ON pending_confirmations(user_id, expires_at);

-- -----------------------------------------------
-- 3. Tabla subscriptions (suscripciones recurrentes)
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  service_name    TEXT NOT NULL,
  amount          NUMERIC(12, 2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'ARS',
  frequency       TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'annual')),
  next_payment_at TIMESTAMPTZ NOT NULL,
  category_id     UUID REFERENCES categories(id),
  notes           TEXT,
  is_active       BOOLEAN DEFAULT true,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions(user_id, is_active, next_payment_at);

-- -----------------------------------------------
-- 4. Agregar deleted_at a transactions (soft delete)
-- -----------------------------------------------

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- -----------------------------------------------
-- 5. Categorías personalizadas por usuario
--
-- Agregar user_id a categories:
--   - NULL = categoría global/predeterminada
--   - UUID = categoría personalizada del usuario
--
-- Reemplazar el UNIQUE simple por índices parciales.
-- -----------------------------------------------

ALTER TABLE categories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- Eliminar el constraint UNIQUE existente de name (migration_001)
-- El nombre auto-generado por PostgreSQL para un UNIQUE inline es: {table}_{column}_key
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;

-- Índice parcial: nombre único entre categorías globales
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_global
  ON categories(name) WHERE user_id IS NULL;

-- Índice parcial: nombre único por usuario
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_user
  ON categories(user_id, name) WHERE user_id IS NOT NULL;

-- -----------------------------------------------
-- 6. Seed de categorías de ingreso (globales)
-- -----------------------------------------------

INSERT INTO categories (name, icon) VALUES
  ('sueldo',           '💼'),
  ('freelance',        '💻'),
  ('regalo',           '🎁'),
  ('alquiler_cobrado', '🏠'),
  ('venta',            '💰'),
  ('dividendos',       '📈'),
  ('reembolso',        '🔄'),
  ('otros_ingresos',   '📥'),
  ('suscripcion',      '🔄')
ON CONFLICT (name) WHERE user_id IS NULL DO NOTHING;

COMMIT;
