-- ==============================================================================
-- Telegram SaaS Payment Bot - Settings & SuperAdmin Enhancements
-- Execute this SQL in Supabase SQL Editor:
-- ==============================================================================

-- 1. Create merchant_settings table
CREATE TABLE IF NOT EXISTS merchant_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE UNIQUE,
    business_name TEXT,
    custom_welcome_msg TEXT,
    custom_thankyou_msg TEXT,
    support_username TEXT,
    invoice_expiry_hours INT DEFAULT 0, -- 0 = No expiration
    notify_on_payment BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Add is_superadmin column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false;

-- 3. Enable RLS and Policies for merchant_settings
ALTER TABLE merchant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read-write for service role" ON merchant_settings
    FOR ALL USING (true) WITH CHECK (true);

-- 4. Create trigger to update updated_at on merchant_settings
CREATE OR REPLACE TRIGGER update_merchant_settings_modtime
    BEFORE UPDATE ON merchant_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

-- ==============================================================================
-- End of Migration Script
-- ==============================================================================
