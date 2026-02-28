-- ============================================================================
-- SUMA — Migration 004: Evolución a Libro Mayor (Ledger)
--
-- Transforma el modelo de "solo gastos" a un sistema contable completo:
--   - Tabla accounts (cuentas del usuario: Efectivo, Banco, MP, etc.)
--   - Tabla transactions (reemplaza expenses, soporta ingresos/gastos/transferencias)
--   - Migración de datos existentes de expenses → transactions
--   - Deprecación de la tabla expenses (rename, no drop)
--
-- IMPORTANTE: Correr en Supabase SQL Editor como una transacción.
-- ============================================================================

BEGIN;

-- -----------------------------------------------
-- 1. Crear ENUMs para tipos
-- -----------------------------------------------

-- Tipos de cuenta
CREATE TYPE account_type AS ENUM (
  'cash',           -- Efectivo
  'bank',           -- Cuenta bancaria
  'digital_wallet', -- MercadoPago, Ualá, etc.
  'credit_card'     -- Tarjeta de crédito
);

-- Tipos de transacción
CREATE TYPE transaction_type AS ENUM (
  'income',    -- Ingreso (sueldo, freelance, venta)
  'expense',   -- Gasto (lo que ya teníamos)
  'transfer'   -- Transferencia entre cuentas propias
);

-- -----------------------------------------------
-- 2. Tabla accounts
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                    -- "Efectivo", "Banco Galicia", "MercadoPago"
  type        account_type NOT NULL DEFAULT 'cash',
  currency    TEXT NOT NULL DEFAULT 'ARS',      -- ISO 4217
  balance     NUMERIC(14, 2) NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,   -- Cuenta por defecto del usuario
  created_at  TIMESTAMPTZ DEFAULT now(),

  -- Un usuario no puede tener dos cuentas con el mismo nombre
  CONSTRAINT uq_user_account_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

-- -----------------------------------------------
-- 3. Tabla transactions (reemplaza expenses)
-- -----------------------------------------------

CREATE TABLE IF NOT EXISTS transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                transaction_type NOT NULL DEFAULT 'expense',
  amount              NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  description         TEXT NOT NULL,
  category_id         UUID REFERENCES categories(id),           -- nullable para transfers
  account_id          UUID NOT NULL REFERENCES accounts(id),    -- de dónde sale/entra el dinero
  destination_account_id UUID REFERENCES accounts(id),          -- solo para transfers

  -- Cuotas e installments
  is_recurrent        BOOLEAN NOT NULL DEFAULT FALSE,
  installment_current INT,                                      -- cuota actual (ej: 3)
  installment_total   INT,                                      -- total de cuotas (ej: 12)

  raw_message         TEXT,                                     -- mensaje original de WhatsApp
  created_at          TIMESTAMPTZ DEFAULT now(),

  -- Validaciones de integridad
  CONSTRAINT chk_installments CHECK (
    (installment_current IS NULL AND installment_total IS NULL)
    OR (installment_current IS NOT NULL AND installment_total IS NOT NULL
        AND installment_current > 0 AND installment_total > 0
        AND installment_current <= installment_total)
  ),
  CONSTRAINT chk_transfer_dest CHECK (
    (type != 'transfer' AND destination_account_id IS NULL)
    OR (type = 'transfer' AND destination_account_id IS NOT NULL)
  )
);

-- Índices para queries frecuentes
CREATE INDEX IF NOT EXISTS idx_transactions_user_date
  ON transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_account
  ON transactions(account_id);

CREATE INDEX IF NOT EXISTS idx_transactions_category
  ON transactions(category_id);

CREATE INDEX IF NOT EXISTS idx_transactions_type
  ON transactions(type);

-- -----------------------------------------------
-- 4. Migración de datos: expenses → transactions
--
-- Paso 4a: Crear cuenta "General" por defecto para cada usuario existente
-- Paso 4b: Copiar expenses a transactions como type='expense'
-- -----------------------------------------------

-- 4a: Crear cuenta "General" (is_default=true) para cada usuario que tenga gastos
INSERT INTO accounts (user_id, name, type, currency, is_default)
SELECT DISTINCT
  e.user_id,
  'General',
  'cash',
  'ARS',
  TRUE
FROM expenses e
ON CONFLICT (user_id, name) DO NOTHING;

-- 4b: Migrar expenses → transactions
INSERT INTO transactions (
  user_id, type, amount, description, category_id,
  account_id, raw_message, created_at
)
SELECT
  e.user_id,
  'expense'::transaction_type,
  e.amount,
  e.description,
  e.category_id,
  a.id,            -- account_id de la cuenta "General" del usuario
  e.raw_message,
  e.created_at
FROM expenses e
JOIN accounts a ON a.user_id = e.user_id AND a.name = 'General';

-- -----------------------------------------------
-- 5. Deprecar tabla expenses (rename, no drop)
--
-- La renombramos para no perder datos si algo sale mal.
-- Se puede dropear manualmente después de verificar la migración.
-- -----------------------------------------------

ALTER TABLE expenses RENAME TO _expenses_deprecated;

-- -----------------------------------------------
-- 6. Actualizar views para usar transactions
-- -----------------------------------------------

-- Eliminar views viejas que referenciaban expenses
DROP VIEW IF EXISTS v_monthly_summary;
DROP VIEW IF EXISTS v_daily_totals;

-- Resumen mensual por categoría (ahora filtrando por tipo)
CREATE OR REPLACE VIEW v_monthly_summary AS
SELECT
  t.user_id,
  u.phone,
  t.type::TEXT AS transaction_type,
  DATE_TRUNC('month', t.created_at) AS month,
  c.name AS category,
  COUNT(*)       AS transaction_count,
  SUM(t.amount)  AS total_amount,
  AVG(t.amount)  AS avg_amount
FROM transactions t
JOIN users u      ON u.id = t.user_id
LEFT JOIN categories c ON c.id = t.category_id
GROUP BY t.user_id, u.phone, t.type, DATE_TRUNC('month', t.created_at), c.name;

-- Totales diarios por usuario y tipo
CREATE OR REPLACE VIEW v_daily_totals AS
SELECT
  t.user_id,
  t.type::TEXT AS transaction_type,
  DATE(t.created_at) AS day,
  SUM(t.amount)       AS total_amount,
  COUNT(*)            AS transaction_count
FROM transactions t
GROUP BY t.user_id, t.type, DATE(t.created_at);

-- Balance por cuenta
CREATE OR REPLACE VIEW v_account_balances AS
SELECT
  a.id AS account_id,
  a.user_id,
  a.name AS account_name,
  a.type::TEXT AS account_type,
  a.currency,
  -- Balance calculado: ingresos - gastos - transferencias salientes + transferencias entrantes
  COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN t.type = 'transfer' AND t.account_id = a.id THEN t.amount ELSE 0 END), 0)
  + COALESCE(transfers_in.total, 0)
  AS calculated_balance
FROM accounts a
LEFT JOIN transactions t ON t.account_id = a.id
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM transactions
  WHERE destination_account_id = a.id AND type = 'transfer'
) transfers_in ON TRUE
GROUP BY a.id, a.user_id, a.name, a.type, a.currency, transfers_in.total;

COMMIT;