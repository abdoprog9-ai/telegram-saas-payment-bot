-- ==============================================================================
-- Telegram SaaS Payment Bot - Plans & Pricing Upgrade Migration
-- Execute this SQL in Supabase SQL Editor:
-- ==============================================================================

-- 1. Insert or Update Tiered Plans
INSERT INTO plans (code, name, price_usd, price_stars, max_bots, included_operations, max_products, is_active)
VALUES 
    ('trial', 'Trial Starter (تجربة لمرة واحدة)', 0.00, 0, 1, 10, 5, true),
    ('monthly_1', 'الباقة الأساسية ($1 / شهر)', 1.00, 50, 1, 100, 10, true),
    ('monthly_3', 'الباقة القياسية ($3 / شهر)', 3.00, 150, 2, 350, 25, true),
    ('monthly_5', 'الباقة المتقدمة ($5 / شهر)', 5.00, 250, 5, 600, 50, true)
ON CONFLICT (code) DO UPDATE 
SET name = EXCLUDED.name,
    price_usd = EXCLUDED.price_usd,
    price_stars = EXCLUDED.price_stars,
    included_operations = EXCLUDED.included_operations,
    max_bots = EXCLUDED.max_bots,
    max_products = EXCLUDED.max_products,
    is_active = true;

-- 2. Create platform_subscription_orders table for tracking merchant plan payments
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

ALTER TABLE platform_subscription_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read-write for service role" ON platform_subscription_orders;
CREATE POLICY "Allow public read-write for service role" ON platform_subscription_orders
    FOR ALL USING (true) WITH CHECK (true);

-- ==============================================================================
-- End of Migration Script
-- ==============================================================================
