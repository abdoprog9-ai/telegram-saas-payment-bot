import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { getPlatformBot } from '../bot/platform-bot.js';
import { Usage, Subscription, Plan } from '../types/index.js';

export interface UsageSummary {
  baseOperations: number;
  bonusCredits: number;
  operationsUsed: number;
  availableOperations: number;
  lowBalanceAlertSent: boolean;
  cycleResetAt: string;
  plan: Plan | null;
}

/**
 * Calculates current available quota and evaluates low-balance alerts
 */
export async function getMerchantUsageSummary(merchantId: string): Promise<UsageSummary> {
  const supabase = getSupabase();

  const [usageRes, subRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
  ]);

  const usage = usageRes.data as Usage | null;
  const sub = subRes.data as (Subscription & { plans: Plan }) | null;

  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  // Check if remaining operations < 10 and alert not yet sent
  if (available < 10 && usage && !usage.low_balance_alert_sent) {
    // Fire background notification asynchronously
    sendLowBalanceAlert(merchantId, available).catch(() => {});
  }

  return {
    baseOperations: base,
    bonusCredits: bonus,
    operationsUsed: used,
    availableOperations: available,
    lowBalanceAlertSent: usage?.low_balance_alert_sent ?? false,
    cycleResetAt: usage?.cycle_reset_at ?? new Date(Date.now() + 30 * 86400000).toISOString(),
    plan: sub?.plans ?? null,
  };
}

/**
 * Sends a non-intrusive one-time low balance notification via the Platform Bot
 */
export async function sendLowBalanceAlert(merchantId: string, available: number): Promise<boolean> {
  const supabase = getSupabase();

  // 1. Fetch Merchant Telegram User ID
  const { data: merchant } = await supabase
    .from('merchants')
    .select('*, users!inner(telegram_user_id)')
    .eq('id', merchantId)
    .single();

  const telegramUserId = (merchant as any)?.users?.telegram_user_id;
  if (!telegramUserId) return false;

  const platformBot = await getPlatformBot();
  if (platformBot) {
    const text =
      `⚠️ <b>تنبيه انخفاض الرصيد:</b>\n\n` +
      `رصيدك المتبقي الحالي هو: <b>${available} عملية</b> (فواتير/طلبات).\n` +
      `هل ترغب في شحن رصيد إضافي أو ترقية خطتك لضمان استمرار المتجر دون توقف؟`;

    const keyboard = new InlineKeyboard()
      .text('⚡ شحن رصيد / ترقية الخطة', 'platform:plans')
      .row()
      .text('لاحقاً', 'platform:dismiss_alert');

    await platformBot.api.sendMessage(telegramUserId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(() => {});
  }

  // 2. Set alert flag to true to prevent repetitive spam
  await supabase
    .from('usage')
    .update({
      low_balance_alert_sent: true,
      last_alert_at: new Date().toISOString(),
    })
    .eq('merchant_id', merchantId);

  return true;
}

/**
 * Adds non-expiring bonus credits to merchant account
 */
export async function addBonusCredits(merchantId: string, credits: number): Promise<Usage> {
  if (credits <= 0) {
    throw new Error('Bonus credits amount must be positive');
  }

  const supabase = getSupabase();

  const { data: currentUsage } = await supabase
    .from('usage')
    .select('bonus_credits, base_operations, operations_used')
    .eq('merchant_id', merchantId)
    .single();

  const newBonus = (currentUsage?.bonus_credits ?? 0) + credits;
  const available = ((currentUsage?.base_operations ?? 20) + newBonus) - (currentUsage?.operations_used ?? 0);

  // If new available >= 10, reset low_balance_alert_sent flag so merchant gets notified next time it drops
  const shouldResetAlertFlag = available >= 10;

  const { data: updatedUsage, error } = await supabase
    .from('usage')
    .update({
      bonus_credits: newBonus,
      low_balance_alert_sent: shouldResetAlertFlag ? false : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('merchant_id', merchantId)
    .select()
    .single();

  if (error || !updatedUsage) {
    throw new Error(`Failed to add bonus credits: ${error?.message}`);
  }

  return updatedUsage;
}

/**
 * Upgrades subscription plan and resets monthly base quota
 */
export async function upgradeMerchantPlan(merchantId: string, planCode: string): Promise<Subscription> {
  const supabase = getSupabase();

  // 1. Fetch Target Plan
  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select('*')
    .eq('code', planCode)
    .eq('is_active', true)
    .single();

  if (planErr || !plan) {
    throw new Error('Selected plan not found or inactive');
  }

  // 2. Update Subscription
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const { data: sub, error: subErr } = await supabase
    .from('subscriptions')
    .upsert({
      merchant_id: merchantId,
      plan_id: plan.id,
      status: 'active',
      starts_at: new Date().toISOString(),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'merchant_id' })
    .select()
    .single();

  if (subErr || !sub) {
    throw new Error(`Failed to update subscription: ${subErr?.message}`);
  }

  // 3. Reset Monthly Base Operations while keeping Bonus Credits intact
  await supabase
    .from('usage')
    .update({
      base_operations: plan.included_operations,
      operations_used: 0,
      low_balance_alert_sent: false,
      cycle_reset_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('merchant_id', merchantId);

  return sub;
}
