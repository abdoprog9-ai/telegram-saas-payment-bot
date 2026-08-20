-- ==============================================================================
-- Telegram SaaS Payment Bot - Database Cleanup (Drop Unused Legacy Tables)
-- Execute this SQL in Supabase SQL Editor:
-- ==============================================================================

-- 1. Drop Legacy Digital Products & Old Catalog Tables (Safe Cascade)
DROP TABLE IF EXISTS digital_product_codes CASCADE;
DROP TABLE IF EXISTS product_codes CASCADE;
DROP TABLE IF EXISTS product_categories CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS bot_sessions CASCADE;
DROP TABLE IF EXISTS analytics_events CASCADE;

-- 2. Ensure Pure Invoicing Tables have proper columns and indexes
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false;

-- 3. Update Existing Records
UPDATE payments SET is_test = true WHERE provider = 'test_sandbox';
UPDATE invoices SET is_test = true WHERE id IN (SELECT invoice_id FROM payments WHERE provider = 'test_sandbox');

-- 4. Recalculate operations_used based exclusively on Real Production Invoices
UPDATE usage u
SET operations_used = (
    SELECT COUNT(*) 
    FROM invoices i 
    WHERE i.merchant_id = u.merchant_id 
      AND (i.is_test IS FALSE OR i.is_test IS NULL) 
      AND i.deleted_at IS NULL
);

-- ==============================================================================
-- End of Database Cleanup Script
-- ==============================================================================
