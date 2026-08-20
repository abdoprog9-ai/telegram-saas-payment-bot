-- ==============================================================================
-- Telegram SaaS Payment Bot - Sandbox Mode Migration
-- Execute this SQL in Supabase SQL Editor:
-- ==============================================================================

-- 1. Add test_mode column to merchant_settings if not exists (default true for easy initial testing)
ALTER TABLE merchant_settings ADD COLUMN IF NOT EXISTS test_mode BOOLEAN DEFAULT true;

-- 2. Update existing settings to enable test_mode
UPDATE merchant_settings SET test_mode = true WHERE test_mode IS NULL;

-- ==============================================================================
-- End of Migration Script
-- ==============================================================================
