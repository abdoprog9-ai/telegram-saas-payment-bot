-- ==============================================================================
-- Telegram SaaS Payment Bot - Master Clean Database Schema (Pure Invoicing SaaS)
-- Execute this entire file in Supabase SQL Editor:
-- ==============================================================================

-- 1. Create modified timestamp trigger function
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id BIGINT UNIQUE,
    email VARCHAR(255) UNIQUE,
    role VARCHAR(50) DEFAULT 'merchant' CHECK (role IN ('superadmin', 'merchant')),
    is_superadmin BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Merchants Table
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Merchant Settings Table
CREATE TABLE IF NOT EXISTS merchant_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE UNIQUE,
    business_name TEXT,
    custom_welcome_msg TEXT,
    custom_thankyou_msg TEXT,
    support_username TEXT,
    invoice_expiry_hours INT DEFAULT 0,
    notify_on_payment BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Telegram Bots Table
CREATE TABLE IF NOT EXISTS telegram_bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    telegram_bot_id BIGINT NOT NULL,
    bot_username VARCHAR(255) NOT NULL,
    bot_first_name VARCHAR(255),
    encrypted_token TEXT NOT NULL,
    token_iv VARCHAR(64) NOT NULL,
    token_auth_tag VARCHAR(64) NOT NULL,
    webhook_secret VARCHAR(128) NOT NULL,
    status VARCHAR(50) DEFAULT 'connected' CHECK (status IN ('connected', 'active', 'disabled', 'webhook_error')),
    last_error_message TEXT,
    last_health_check_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Plans Table
CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    price_usd NUMERIC(10, 2) DEFAULT 0.00,
    price_stars INT DEFAULT 0,
    max_bots INT DEFAULT 1,
    included_operations INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Tiered Plans
INSERT INTO plans (code, name, price_usd, price_stars, max_bots, included_operations, is_active)
VALUES 
    ('trial', 'Trial Starter (تجربة لمرة واحدة)', 0.00, 0, 1, 10, true),
    ('monthly_1', 'الباقة الأساسية ($1 / شهر)', 1.00, 50, 1, 100, true),
    ('monthly_3', 'الباقة القياسية ($3 / شهر)', 3.00, 150, 2, 350, true),
    ('monthly_5', 'الباقة المتقدمة ($5 / شهر)', 5.00, 250, 5, 600, true)
ON CONFLICT (code) DO UPDATE 
SET name = EXCLUDED.name,
    price_usd = EXCLUDED.price_usd,
    price_stars = EXCLUDED.price_stars,
    included_operations = EXCLUDED.included_operations,
    max_bots = EXCLUDED.max_bots,
    is_active = true;

-- 7. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE UNIQUE,
    plan_id UUID NOT NULL REFERENCES plans(id),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'grace_period')),
    starts_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Usage Quota Table
CREATE TABLE IF NOT EXISTS usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE UNIQUE,
    base_operations INT DEFAULT 10,
    bonus_credits INT DEFAULT 0,
    operations_used INT DEFAULT 0,
    low_balance_alert_sent BOOLEAN DEFAULT FALSE,
    last_alert_at TIMESTAMPTZ,
    cycle_reset_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Customers Table
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    telegram_user_id BIGINT NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, telegram_user_id)
);

-- 10. Invoices Table
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    bot_id UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id),
    invoice_number VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    currency VARCHAR(10) DEFAULT 'XTR',
    total_amount INT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'paid', 'cancelled', 'deleted', 'refunded', 'expired')),
    expires_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Payments Table
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    provider VARCHAR(50) DEFAULT 'telegram_stars',
    telegram_charge_id VARCHAR(255) UNIQUE NOT NULL,
    amount INT NOT NULL,
    currency VARCHAR(10) DEFAULT 'XTR',
    status VARCHAR(50) DEFAULT 'successful',
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Refunds Table
CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    amount INT NOT NULL,
    reason TEXT,
    telegram_refund_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'completed',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Webhook Events Table (De-duplication layer)
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    update_id BIGINT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(bot_id, update_id)
);

-- 14. Platform Subscription Orders Table
CREATE TABLE IF NOT EXISTS platform_subscription_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    telegram_user_id BIGINT NOT NULL,
    item_type VARCHAR(50) NOT NULL CHECK (item_type IN ('plan', 'credit_pack')),
    item_code VARCHAR(50) NOT NULL,
    amount_stars INT NOT NULL,
    telegram_charge_id VARCHAR(255) UNIQUE,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Stored Procedures & Triggers
CREATE OR REPLACE FUNCTION deduct_merchant_operation(p_merchant_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE usage
    SET operations_used = operations_used + 1,
        updated_at = NOW()
    WHERE merchant_id = p_merchant_id;
END;
$$ LANGUAGE plpgsql;

-- Apply Triggers
DROP TRIGGER IF EXISTS update_users_modtime ON users;
CREATE TRIGGER update_users_modtime BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_modified_column();

DROP TRIGGER IF EXISTS update_merchants_modtime ON merchants;
CREATE TRIGGER update_merchants_modtime BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION update_modified_column();

DROP TRIGGER IF EXISTS update_merchant_settings_modtime ON merchant_settings;
CREATE TRIGGER update_merchant_settings_modtime BEFORE UPDATE ON merchant_settings FOR EACH ROW EXECUTE FUNCTION update_modified_column();

DROP TRIGGER IF EXISTS update_telegram_bots_modtime ON telegram_bots;
CREATE TRIGGER update_telegram_bots_modtime BEFORE UPDATE ON telegram_bots FOR EACH ROW EXECUTE FUNCTION update_modified_column();

DROP TRIGGER IF EXISTS update_invoices_modtime ON invoices;
CREATE TRIGGER update_invoices_modtime BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_modified_column();

-- Enable RLS on all tables with open service role policy
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_subscription_orders ENABLE ROW LEVEL SECURITY;

DO $$ 
DECLARE 
    t text;
BEGIN
    FOR t IN 
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' 
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Allow public read-write for service role" ON %I;', t);
        EXECUTE format('CREATE POLICY "Allow public read-write for service role" ON %I FOR ALL USING (true) WITH CHECK (true);', t);
    END LOOP;
END $$;

-- ==============================================================================
-- End of Master Clean Database Schema
-- ==============================================================================
