-- ====================================================================
-- Telegram SaaS Payment & Bot Platform - Supabase PostgreSQL Schema DDL
-- Multi-Tenant, UUID-based, Row-Level Security Enabled
-- ====================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Clean drop for idempotency in dev/test setups if needed
-- DROP TABLE IF EXISTS audit_logs CASCADE;
-- DROP TABLE IF EXISTS notifications CASCADE;
-- DROP TABLE IF EXISTS webhook_events CASCADE;
-- DROP TABLE IF EXISTS refunds CASCADE;
-- DROP TABLE IF EXISTS payments CASCADE;
-- DROP TABLE IF EXISTS orders CASCADE;
-- DROP TABLE IF EXISTS invoice_items CASCADE;
-- DROP TABLE IF EXISTS invoices CASCADE;
-- DROP TABLE IF EXISTS digital_product_codes CASCADE;
-- DROP TABLE IF EXISTS products CASCADE;
-- DROP TABLE IF EXISTS customers CASCADE;
-- DROP TABLE IF EXISTS telegram_bots CASCADE;
-- DROP TABLE IF EXISTS usage CASCADE;
-- DROP TABLE IF EXISTS subscriptions CASCADE;
-- DROP TABLE IF EXISTS plans CASCADE;
-- DROP TABLE IF EXISTS merchants CASCADE;
-- DROP TABLE IF EXISTS users CASCADE;

-- 2. Users Table (Platform Account Owners)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id BIGINT UNIQUE,
    email VARCHAR(255) UNIQUE,
    role VARCHAR(50) DEFAULT 'merchant' CHECK (role IN ('superadmin', 'merchant')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Merchants Table (Business Account Profile)
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Plans Table (Dynamic Pricing & Quota Definitions)
CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    price_usd NUMERIC(10, 2) DEFAULT 0.00,
    price_stars INT DEFAULT 0,
    max_bots INT DEFAULT 1,
    included_operations INT NOT NULL,
    max_products INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Initial Free and Pro Plans
INSERT INTO plans (code, name, price_usd, price_stars, max_bots, included_operations, max_products)
VALUES 
    ('free', 'Free Starter', 0.00, 0, 1, 20, 5),
    ('pro_monthly', 'Pro Merchant Monthly', 1.00, 50, 5, 100, 50)
ON CONFLICT (code) DO UPDATE 
SET price_usd = EXCLUDED.price_usd,
    price_stars = EXCLUDED.price_stars,
    included_operations = EXCLUDED.included_operations,
    max_products = EXCLUDED.max_products;

-- 5. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'grace_period')),
    starts_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Usage Table (Account-Level Quota, Rollover Bonus, and Alert Flags)
CREATE TABLE IF NOT EXISTS usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID UNIQUE NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    base_operations INT DEFAULT 20,
    bonus_credits INT DEFAULT 0,
    operations_used INT DEFAULT 0,
    low_balance_alert_sent BOOLEAN DEFAULT FALSE,
    last_alert_at TIMESTAMPTZ,
    cycle_reset_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 month'),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Telegram Bots Table (Encrypted Tokens & Status Lifecycle)
CREATE TABLE IF NOT EXISTS telegram_bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    telegram_bot_id BIGINT UNIQUE NOT NULL,
    bot_username VARCHAR(255) NOT NULL,
    bot_first_name VARCHAR(255),
    encrypted_token TEXT NOT NULL,
    token_iv VARCHAR(64) NOT NULL,
    token_auth_tag VARCHAR(64) NOT NULL,
    webhook_secret VARCHAR(128) NOT NULL,
    status VARCHAR(50) DEFAULT 'connected' 
        CHECK (status IN ('connected', 'active', 'token_invalid', 'disabled', 'webhook_error')),
    last_error_message TEXT,
    last_health_check_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Customers Table
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    telegram_user_id BIGINT NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (merchant_id, telegram_user_id)
);

-- 9. Products Table (Distinct Digital Entities)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    bot_id UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price_stars INT NOT NULL,
    product_type VARCHAR(50) DEFAULT 'code' CHECK (product_type IN ('code', 'file', 'content')),
    is_active BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Digital Product Codes Inventory (Unlimited per Product)
CREATE TABLE IF NOT EXISTS digital_product_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    code_value TEXT NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    assigned_order_id UUID,
    assigned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Invoices Table (Soft-Delete Protected)
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    bot_id UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id),
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    currency VARCHAR(10) DEFAULT 'XTR',
    total_amount INT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'paid', 'cancelled', 'deleted', 'refunded', 'expired')),
    telegram_payment_charge_id VARCHAR(255) UNIQUE,
    expires_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Invoice Items
CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    title VARCHAR(255) NOT NULL,
    quantity INT DEFAULT 1,
    unit_price INT NOT NULL,
    total_price INT NOT NULL
);

-- 13. Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    bot_id UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id),
    product_id UUID REFERENCES products(id),
    invoice_id UUID REFERENCES invoices(id),
    amount INT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'paid', 'processing', 'completed', 'cancelled', 'refunded')),
    delivered_payload TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Payments Table (Idempotent Record)
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    provider VARCHAR(50) DEFAULT 'telegram_stars',
    telegram_charge_id VARCHAR(255) UNIQUE NOT NULL,
    provider_payment_charge_id VARCHAR(255),
    amount INT NOT NULL,
    currency VARCHAR(10) DEFAULT 'XTR',
    status VARCHAR(50) DEFAULT 'successful',
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Refunds Table
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

-- 16. Webhook Events Table (De-duplication layer)
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
    update_id BIGINT NOT NULL,
    event_type VARCHAR(100),
    is_processed BOOLEAN DEFAULT TRUE,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(bot_id, update_id)
);

-- 17. Notifications Table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 18. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    details JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ====================================================================
-- Performance Indexes
-- ====================================================================
CREATE INDEX IF NOT EXISTS idx_telegram_bots_bot_id ON telegram_bots(telegram_bot_id);
CREATE INDEX IF NOT EXISTS idx_telegram_bots_status ON telegram_bots(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_digital_codes_fetch ON digital_product_codes(product_id, is_used) WHERE is_used = FALSE;
CREATE INDEX IF NOT EXISTS idx_invoices_lookup ON invoices(merchant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_lookup ON orders(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_lookup ON webhook_events(bot_id, update_id);

-- ====================================================================
-- Atomic Business Logic Functions in PostgreSQL
-- ====================================================================

-- 1. Get Merchant Available Operations: (base + bonus) - used
CREATE OR REPLACE FUNCTION get_merchant_available_operations(p_merchant_id UUID)
RETURNS INT AS $$
DECLARE
    v_available INT;
BEGIN
    SELECT (base_operations + bonus_credits - operations_used) INTO v_available
    FROM usage
    WHERE merchant_id = p_merchant_id;

    RETURN COALESCE(v_available, 0);
END;
$$ LANGUAGE plpgsql;

-- 2. Deduct 1 Operation Atomically (Throws exception if depleted)
CREATE OR REPLACE FUNCTION deduct_merchant_operation(p_merchant_id UUID)
RETURNS INT AS $$
DECLARE
    v_available INT;
    v_new_used INT;
BEGIN
    -- Lock the usage row for update
    SELECT (base_operations + bonus_credits - operations_used) INTO v_available
    FROM usage
    WHERE merchant_id = p_merchant_id
    FOR UPDATE;

    IF v_available <= 0 THEN
        RAISE EXCEPTION 'MERCHANT_QUOTA_EXHAUSTED';
    END IF;

    UPDATE usage
    SET operations_used = operations_used + 1,
        updated_at = NOW()
    WHERE merchant_id = p_merchant_id
    RETURNING operations_used INTO v_new_used;

    RETURN v_new_used;
END;
$$ LANGUAGE plpgsql;

-- 3. Reset Monthly Subscription Cycle
CREATE OR REPLACE FUNCTION reset_monthly_merchant_cycle(p_merchant_id UUID, p_new_base INT)
RETURNS VOID AS $$
BEGIN
    UPDATE usage
    SET base_operations = p_new_base,
        operations_used = 0,
        low_balance_alert_sent = FALSE,
        cycle_reset_at = NOW() + INTERVAL '1 month',
        updated_at = NOW()
    WHERE merchant_id = p_merchant_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Process Successful Payment Idempotently with Atomic Code Claim by Primary Key (ID)
CREATE OR REPLACE FUNCTION process_successful_payment_idempotent(
    p_bot_id UUID,
    p_merchant_id UUID,
    p_invoice_id UUID,
    p_order_id UUID,
    p_telegram_charge_id TEXT,
    p_amount INT,
    p_product_id UUID,
    p_payload JSONB
)
RETURNS TABLE (
    success BOOLEAN,
    delivered_code TEXT,
    message TEXT
) AS $$
DECLARE
    v_existing_payment_id UUID;
    v_code_id UUID;
    v_code_value TEXT;
BEGIN
    -- Step 1: Idempotency Check
    SELECT id INTO v_existing_payment_id FROM payments WHERE telegram_charge_id = p_telegram_charge_id;
    IF v_existing_payment_id IS NOT NULL THEN
        RETURN QUERY SELECT TRUE, NULL::TEXT, 'Payment already processed (Idempotent replay)';
        RETURN;
    END IF;

    -- Step 2: Record Payment
    INSERT INTO payments (invoice_id, merchant_id, provider, telegram_charge_id, amount, status, raw_payload)
    VALUES (p_invoice_id, p_merchant_id, 'telegram_stars', p_telegram_charge_id, p_amount, 'successful', p_payload);

    -- Step 3: Atomic Lock & Claim of Single Code By ID (SKIP LOCKED)
    IF p_product_id IS NOT NULL THEN
        SELECT id, code_value INTO v_code_id, v_code_value
        FROM digital_product_codes
        WHERE product_id = p_product_id 
          AND merchant_id = p_merchant_id 
          AND is_used = FALSE
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        IF v_code_id IS NOT NULL THEN
            UPDATE digital_product_codes
            SET is_used = TRUE,
                assigned_order_id = p_order_id,
                assigned_at = NOW()
            WHERE id = v_code_id; -- Exact Primary Key update
        END IF;
    END IF;

    -- Step 4: Update Invoice and Order
    UPDATE invoices 
    SET status = 'paid', paid_at = NOW(), telegram_payment_charge_id = p_telegram_charge_id, updated_at = NOW()
    WHERE id = p_invoice_id;

    IF p_order_id IS NOT NULL THEN
        UPDATE orders 
        SET status = 'completed', delivered_payload = v_code_value, updated_at = NOW()
        WHERE id = p_order_id;
    END IF;

    RETURN QUERY SELECT TRUE, v_code_value, 'Payment processed and fulfilled successfully';
END;
$$ LANGUAGE plpgsql;
