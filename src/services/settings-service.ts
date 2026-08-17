import { getSupabase } from '../database/supabase.js';
import { MerchantSettings } from '../types/index.js';

/**
 * Retrieves settings for a merchant, creating defaults if not yet present
 */
export async function getMerchantSettings(merchantId: string): Promise<MerchantSettings> {
  const supabase = getSupabase();

  const { data: existing, error } = await supabase
    .from('merchant_settings')
    .select('*')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (existing) {
    return existing as MerchantSettings;
  }

  // If table doesn't exist yet (before SQL migration), return safe in-memory fallback defaults
  const defaults: MerchantSettings = {
    id: 'default',
    merchant_id: merchantId,
    business_name: null,
    custom_welcome_msg: null,
    custom_thankyou_msg: null,
    support_username: null,
    invoice_expiry_hours: 0,
    notify_on_payment: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    const { data: created } = await supabase
      .from('merchant_settings')
      .insert({
        merchant_id: merchantId,
        invoice_expiry_hours: 0,
        notify_on_payment: true,
      })
      .select()
      .maybeSingle();

    if (created) {
      return created as MerchantSettings;
    }
  } catch {}

  return defaults;
}

/**
 * Updates settings for a merchant
 */
export async function updateMerchantSettings(
  merchantId: string,
  updates: Partial<Omit<MerchantSettings, 'id' | 'merchant_id' | 'created_at' | 'updated_at'>>
): Promise<MerchantSettings> {
  const supabase = getSupabase();

  // Try upserting into merchant_settings
  const { data, error } = await supabase
    .from('merchant_settings')
    .upsert({
      merchant_id: merchantId,
      ...updates,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'merchant_id' })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to update settings: ${error?.message || 'Unknown database error'}`);
  }

  return data as MerchantSettings;
}
