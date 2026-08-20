export type UserRole = 'superadmin' | 'merchant';
export type MerchantStatus = 'active' | 'suspended' | 'cancelled';
export type SubscriptionStatus = 'active' | 'expired' | 'grace_period';
export type BotStatus = 'connected' | 'active' | 'token_invalid' | 'disabled' | 'webhook_error';
export type InvoiceStatus = 'pending' | 'paid' | 'cancelled' | 'deleted' | 'refunded' | 'expired';
export type PaymentStatus = 'successful' | 'failed' | 'refunded';
export type ProductType = 'digital_code' | 'service' | 'file' | 'content' | 'code';
export type OrderStatus = 'pending' | 'paid' | 'delivered' | 'failed' | 'cancelled';

export interface Product {
  id: string;
  merchant_id: string;
  bot_id: string;
  name: string;
  description?: string | null;
  price_stars: number;
  product_type: ProductType;
  file_url?: string | null;
  content_data?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface DigitalProductCode {
  id: string;
  product_id: string;
  merchant_id: string;
  code_value: string;
  is_used: boolean;
  used_at?: string | null;
  order_id?: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  merchant_id: string;
  bot_id: string;
  customer_id: string;
  product_id: string;
  invoice_id: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  delivered_code_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string; // UUID v4
  telegram_user_id?: number | null;
  email?: string | null;
  role: UserRole;
  is_superadmin?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Merchant {
  id: string; // UUID v4
  user_id: string; // UUID v4
  business_name: string;
  status: MerchantStatus;
  created_at: string;
  updated_at: string;
}

export interface MerchantSettings {
  id: string;
  merchant_id: string;
  business_name?: string | null;
  custom_welcome_msg?: string | null;
  custom_thankyou_msg?: string | null;
  support_username?: string | null;
  invoice_expiry_hours?: number;
  notify_on_payment?: boolean;
  test_mode?: boolean; // Single toggle for Live vs Sandbox
  created_at: string;
  updated_at: string;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  price_usd: number;
  price_stars: number;
  max_bots: number;
  included_operations: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  merchant_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  starts_at: string;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Usage {
  id: string;
  merchant_id: string;
  base_operations: number;
  bonus_credits: number;
  operations_used: number;
  low_balance_alert_sent: boolean;
  last_alert_at?: string | null;
  cycle_reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface TelegramBot {
  id: string;
  merchant_id: string;
  telegram_bot_id: number;
  bot_username: string;
  bot_first_name?: string | null;
  encrypted_token: string;
  token_iv: string;
  token_auth_tag: string;
  webhook_secret: string;
  status: BotStatus;
  last_error_message?: string | null;
  last_health_check_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: string;
  merchant_id: string;
  telegram_user_id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  merchant_id: string;
  bot_id: string;
  customer_id?: string | null;
  invoice_number: string;
  title: string;
  description?: string | null;
  total_amount: number;
  currency: string;
  status: InvoiceStatus;
  is_test?: boolean;
  expires_at?: string | null;
  paid_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  invoice_id: string;
  merchant_id: string;
  provider: string;
  telegram_charge_id: string;
  provider_payment_charge_id?: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  is_test?: boolean;
  raw_payload?: Record<string, any> | null;
  created_at: string;
}

export interface Refund {
  id: string;
  payment_id: string;
  merchant_id: string;
  amount: number;
  reason?: string | null;
  telegram_refund_id?: string | null;
  status: string;
  created_at: string;
}

export interface PlatformSubscriptionOrder {
  id: string;
  merchant_id: string;
  telegram_user_id: number;
  item_type: 'plan' | 'credit_pack';
  item_code: string;
  amount_stars: number;
  telegram_charge_id?: string | null;
  status: 'pending' | 'paid' | 'cancelled';
  created_at: string;
  updated_at: string;
}
