export type UserRole = 'superadmin' | 'merchant';
export type MerchantStatus = 'active' | 'suspended' | 'cancelled';
export type SubscriptionStatus = 'active' | 'expired' | 'grace_period';
export type BotStatus = 'connected' | 'active' | 'token_invalid' | 'disabled' | 'webhook_error';
export type ProductType = 'code' | 'file' | 'content';
export type InvoiceStatus = 'pending' | 'paid' | 'cancelled' | 'deleted' | 'refunded' | 'expired';
export type OrderStatus = 'pending' | 'paid' | 'processing' | 'completed' | 'cancelled' | 'refunded';
export type PaymentStatus = 'successful' | 'failed' | 'refunded';

export interface User {
  id: string; // UUID v4
  telegram_user_id?: number | null;
  email?: string | null;
  role: UserRole;
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

export interface Plan {
  id: string;
  code: string;
  name: string;
  price_usd: number;
  price_stars: number;
  max_bots: number;
  included_operations: number;
  max_products: number;
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

export interface Product {
  id: string;
  merchant_id: string;
  bot_id: string;
  name: string;
  description?: string | null;
  price_stars: number;
  product_type: ProductType;
  is_active: boolean;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DigitalProductCode {
  id: string;
  product_id: string;
  merchant_id: string;
  code_value: string;
  is_used: boolean;
  assigned_order_id?: string | null;
  assigned_at?: string | null;
  created_at: string;
}

export interface Invoice {
  id: string;
  merchant_id: string;
  bot_id: string;
  customer_id?: string | null;
  invoice_number: string;
  title: string;
  description?: string | null;
  currency: string;
  total_amount: number;
  status: InvoiceStatus;
  telegram_payment_charge_id?: string | null;
  expires_at?: string | null;
  paid_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  merchant_id: string;
  bot_id: string;
  customer_id: string;
  product_id?: string | null;
  invoice_id?: string | null;
  amount: number;
  status: OrderStatus;
  delivered_payload?: string | null;
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
  raw_payload?: Record<string, unknown> | null;
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

export interface WebhookEvent {
  id: string;
  bot_id: string;
  update_id: number;
  event_type?: string | null;
  is_processed: boolean;
  payload?: Record<string, unknown> | null;
  created_at: string;
}
