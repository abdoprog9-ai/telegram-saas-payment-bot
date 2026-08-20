-- ==============================================================================
-- Telegram SaaS Payment Bot - Full Sandbox Isolation Migration
-- Execute this SQL in Supabase SQL Editor:
-- ==============================================================================

-- 1. Add is_test column to invoices table
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false;

-- 2. Add is_test column to payments table
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false;

-- 3. Flag existing test payments and test invoices as is_test = true
UPDATE payments SET is_test = true WHERE provider = 'test_sandbox';
UPDATE invoices SET is_test = true WHERE id IN (SELECT invoice_id FROM payments WHERE provider = 'test_sandbox');

-- 4. Reset/Recalculate operations_used for merchants based strictly on real invoices (excluding test invoices)
UPDATE usage u
SET operations_used = (
    SELECT COUNT(*) 
    FROM invoices i 
    WHERE i.merchant_id = u.merchant_id 
      AND (i.is_test IS FALSE OR i.is_test IS NULL) 
      AND i.deleted_at IS NULL
);

-- ==============================================================================
-- End of Migration Script
-- ==============================================================================
