import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';

export interface AdminContextInfo {
  botId: string;
  merchantId: string;
  telegramUserId: number;
}

/**
 * Builds the Main Admin Dashboard Inline Keyboard
 */
export function buildAdminMainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📄 الفواتير', 'admin:invoices')
    .text('📦 المنتجات', 'admin:products')
    .row()
    .text('🛒 الطلبات', 'admin:orders')
    .text('💳 اشتراكي', 'admin:subscription')
    .row()
    .text('⚙️ الإعدادات', 'admin:settings')
    .text('🔄 تحديث', 'admin:refresh');
}

/**
 * Handles the /start or /admin command for Merchant Bot Admin
 */
export async function renderAdminDashboard(ctx: any, merchantId: string, botUsername: string) {
  const supabase = getSupabase();

  // Fetch quick metrics for the dashboard summary
  const [usageRes, subRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const planName = sub?.plans?.name || 'Free Starter';
  
  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  const text = 
    `👑 <b>لوحة تحكم التاجر | @${botUsername}</b>\n\n` +
    `📊 <b>ملخص الحساب:</b>\n` +
    `• الخطة: <b>${planName}</b>\n` +
    `• العمليات المتاحة: <b>${available}</b> (المستخدم: ${used})\n` +
    `• الرصيد الإضافي: <b>${bonus}</b>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? '🟢 نشط' : '🔴 متوقف'}</b>\n\n` +
    `اختر من القائمة أدناه لإدارة متجرك وفواتيرك:`;

  const keyboard = buildAdminMainMenu();

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:subscription' button click
 */
export async function handleSubscriptionView(ctx: any, merchantId: string) {
  const supabase = getSupabase();

  const [usageRes, subRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const plan = sub?.plans;

  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  const resetDate = usage?.cycle_reset_at ? new Date(usage.cycle_reset_at).toLocaleDateString('ar-EG') : 'غير محدد';

  const text = 
    `💳 <b>تفاصيل اشتراكي والخطة:</b>\n\n` +
    `• الخطة الحالية: <b>${plan?.name || 'Free Starter'}</b>\n` +
    `• الرصيد الأساسي للدورة: <b>${base}</b> عملية\n` +
    `• الرصيد الإضافي التراكمي (Bonus): <b>${bonus}</b> عملية\n` +
    `• العمليات المستهلكة: <b>${used}</b> عملية\n` +
    `• <b>الرصيد المتبقي المتاح:</b> <code>${available}</code> عملية\n` +
    `• تاريخ التجديد القادم: <b>${resetDate}</b>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? '🟢 نشط' : '🔴 متوقف'}</b>\n\n` +
    `💡 <i>ملاحظة: لشحن رصيد إضافي أو ترقية الباقة، يمكنك زيارة بوت المنصة الأساسي.</i>`;

  const keyboard = new InlineKeyboard()
    .text('⚡ ترقية / شحن رصيد', 'admin:upgrade_prompt')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/**
 * Handles 'admin:products' button click - lists products & stock
 */
export async function handleProductsView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();

  const { data: products } = await supabase
    .from('products')
    .select('*, digital_product_codes(count)')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  let text = `📦 <b>إدارة المنتجات الرقمية:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!products || products.length === 0) {
    text += `<i>لا يوجد لديك منتجات مضافة حتى الآن.</i>\n\n`;
  } else {
    text += `لديك <b>${products.length}</b> منتج معروض:\n\n`;
    for (const p of products) {
      text += `• <b>${p.name}</b> (${p.price_stars} ⭐️)\n`;
      text += `  النوع: <code>${p.product_type}</code>\n`;
    }
  }

  keyboard
    .text('➕ إضافة منتج جديد', 'admin:add_product')
    .text('📥 استيراد أكواد', 'admin:import_codes')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
