-- ============================================================================
-- SUMA — Migration 007: Subscription alerts & duration
--
-- Adds end_date, alert_date, and alert_sent to the subscriptions table
-- to support time-bound subscriptions and proactive renewal reminders.
--
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
-- ============================================================================

-- Fecha de fin de la suscripción (null = indefinida, como antes)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;
COMMENT ON COLUMN subscriptions.end_date IS 'Subscription end date. NULL means indefinite (no expiry).';

-- Fecha programada para enviar alerta de vencimiento
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS alert_date TIMESTAMPTZ;
COMMENT ON COLUMN subscriptions.alert_date IS 'Date to send expiry reminder. NULL means no alert scheduled.';

-- Guard de idempotencia: evita enviar la alerta más de una vez
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS alert_sent BOOLEAN DEFAULT false;
COMMENT ON COLUMN subscriptions.alert_sent IS 'True once the expiry alert has been sent. Prevents duplicate alerts.';

-- Índice para el cron job: buscar alertas pendientes de envío
CREATE INDEX IF NOT EXISTS idx_subscriptions_pending_alerts
  ON subscriptions (alert_date)
  WHERE alert_sent = false AND is_active = true AND alert_date IS NOT NULL;
