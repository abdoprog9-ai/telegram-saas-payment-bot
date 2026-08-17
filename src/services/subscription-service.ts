import { Api, InlineKeyboard } from 'grammy';
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

export const CREDIT_PACKS: Record<string, { code: string; name: string; credits: number; priceStars: number }> = {
  pack_50: { code: 'pack_50', name: 'باقة 50 عملية إضافية', credits: 50, priceStars: 25 },
  pack_200: { code: 'pack_200', name: 'باقة 200 عملية إضافية', credits: 200, priceStars: 90 },
  pack_500: { code: 'pack_500', name: 'باقة 500 عملية إضافية', credits: 500, priceStars: 200 },
};

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

  const base = usage?.base_operations ?? 10;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  // Check if remaining operations < 10 and alert not yet sent
  if (available < 10 && usage && !usage.low_balance_alert_sent) {
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
      `رصيدك المتبقي الحالي هو: <b>${available} عملية</b> (فواتير/مدفوعات).\n` +
      `يمكنك ترقية خطتك أو شحن رصيد عمليات إضافي لضمان استمرار البوت دون توقف:`;

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
 * Adds non-expiring bonus credits to merchant account (e.g. for custom admin top-ups or credit packs)
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
  const available = ((currentUsage?.base_operations ?? 10) + newBonus) - (currentUsage?.operations_used ?? 0);

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
 * Upgrades subscription plan and resets monthly base quota (30 days cycle)
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
    throw new Error(`Selected plan not found or inactive: ${planCode}`);
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

/**
 * Sends a Telegram Stars Invoice from Platform Bot for purchasing a Plan or Credit Pack
 */
export async function sendPlatformSubscriptionStarsInvoice(
  api: Api,
  chatId: number,
  merchantId: string,
  type: 'plan' | 'credit_pack',
  code: string
): Promise<any> {
  const supabase = getSupabase();

  let title = '';
  let description = '';
  let starsAmount = 0;

  if (type === 'plan') {
    const { data: plan } = await supabase.from('plans').select('*').eq('code', code).single();
    if (!plan) throw new Error('Plan not found');
    title = `اشتراك ${plan.name}`;
    description = `ترقية متجرك لباقة ${plan.name} (${plan.included_operations} عملية شهرياً)`;
    starsAmount = plan.price_stars;
  } else {
    const pack = CREDIT_PACKS[code];
    if (!pack) throw new Error('Credit pack not found');
    title = pack.name;
    description = `شحن ${pack.credits} عملية إضافية دائمة لا تنتهي`;
    starsAmount = pack.priceStars;
  }

  // Compact payload < 128 bytes
  const payloadStr = JSON.stringify({
    t: type,
    m: merchantId,
    c: code,
  });

  return await api.sendInvoice(
    chatId,
    title.slice(0, 32),
    description.slice(0, 255),
    payloadStr,
    'XTR',
    [
      {
        label: title.slice(0, 32),
        amount: starsAmount,
      },
    ]
  );
}
