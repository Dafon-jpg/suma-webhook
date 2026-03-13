-- ============================================================================
-- SUMA — Migration 006: Suscripciones unificadas + tablas NextAuth
--
-- Parte A: Campos de suscripción en users (MercadoPago + Stripe futuro)
-- Parte B: Tabla web_sessions (NextAuth)
-- Parte C: Tabla verification_tokens (NextAuth)
--
-- Idempotente: usa IF NOT EXISTS y ADD COLUMN IF NOT EXISTS.
-- ============================================================================

-- -----------------------------------------------
-- Parte A: Campos de suscripción en users
-- -----------------------------------------------

-- Estado de suscripción (reemplaza is_subscribed a futuro)
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none';
COMMENT ON COLUMN users.subscription_status IS 'none | pending | active | cancelled';

-- MercadoPago
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_subscription_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_customer_id TEXT;

-- Stripe (futuro)
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_current_period_end TIMESTAMPTZ;

-- Migrar datos existentes de is_subscribed → subscription_status
UPDATE users SET subscription_status = 'active' WHERE is_subscribed = true;
UPDATE users SET subscription_status = 'none' WHERE is_subscribed = false OR is_subscribed IS NULL;

-- NO eliminar is_subscribed todavía (el frontend de Caro lo usa)

-- -----------------------------------------------
-- Parte B: Tabla web_sessions (NextAuth)
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS web_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_token TEXT UNIQUE NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires       TIMESTAMPTZ NOT NULL
);

-- -----------------------------------------------
-- Parte C: Tabla verification_tokens (NextAuth)
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier TEXT NOT NULL,
  token      TEXT UNIQUE NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identifier, token)
);
