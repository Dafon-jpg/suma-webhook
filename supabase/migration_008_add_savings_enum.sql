-- ======================================================
-- SUMA — Migration 008: Agregar 'savings' al ENUM de transactions.type
-- Ejecutar en Supabase SQL Editor
-- ======================================================

-- 1. Agregar 'savings' al tipo ENUM de la columna type
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'savings';

-- 2. Si lo anterior falla porque no hay un tipo ENUM definido 
-- (la columna usa CHECK constraint en vez de ENUM), ejecutá esto:
-- ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
-- ALTER TABLE transactions ADD CONSTRAINT transactions_type_check 
--   CHECK (type IN ('income', 'expense', 'savings'));

-- 3. Políticas de RLS necesarias para el rol anon
-- DELETE en transactions
CREATE POLICY "Allow anon delete transactions"
ON transactions FOR DELETE
TO anon
USING (true);

-- UPDATE en transactions  
CREATE POLICY "Allow anon update transactions"
ON transactions FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- INSERT en accounts (necesario para crear la cuenta default)
CREATE POLICY "Allow anon insert accounts"
ON accounts FOR INSERT
TO anon
WITH CHECK (true);

-- SELECT en accounts
CREATE POLICY "Allow anon select accounts"  
ON accounts FOR SELECT
TO anon
USING (true);

-- INSERT en categories (para categorías personalizadas)
CREATE POLICY "Allow anon insert categories"
ON categories FOR INSERT
TO anon
WITH CHECK (true);
