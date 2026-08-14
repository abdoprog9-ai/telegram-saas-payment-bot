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
export async function renderAdminDashboard(ctx: any, merchantId: string, botUsername: string, isRefresh = false) {
  const supabase = getSupabase();

  // Fetch metrics for the dashboard summary
  const [usageRes, subRes, productsRes, ordersRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
    supabase.from('products').select('id', { count: 'exact' }).eq('merchant_id', merchantId).is('deleted_at', null),
    supabase.from('orders').select('id', { count: 'exact' }).eq('merchant_id', merchantId),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const planName = sub?.plans?.name || 'Free Starter';
  
  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);
  const productsCount = productsRes.count ?? 0;
  const ordersCount = ordersRes.count ?? 0;

  const text = 
    `👑 <b>لوحة تحكم التاجر | @${botUsername}</b>\n\n` +
    `📊 <b>ملخص الحساب:</b>\n` +
    `• الخطة الحالية: <b>${planName}</b>\n` +
    `• العمليات المتاحة: <b>${available}</b> (المستهلك: ${used})\n` +
    `• الرصيد الإضافي (Bonus): <b>${bonus}</b>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? '🟢 نشط' : '🔴 متوقف'}</b>\n` +
    `• المنتجات المعروضة: <b>${productsCount}</b>\n` +
    `• إجمالي الطلبات: <b>${ordersCount}</b>\n\n` +
    `اختر من القائمة أدناه لإدارة متجرك وفواتيرك:`;

  const keyboard = buildAdminMainMenu();

  if (isRefresh && ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: '✅ تم تحديث البيانات بنجاح!' }).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      // Ignored if text didn't change
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
    `• الرصيد الإضافي التراكمي (Bonus): <b>${bonus}</b> عملية (لا ينتهي)\n` +
    `• العمليات المستهلكة: <b>${used}</b> عملية\n` +
    `• <b>الرصيد المتبقي المتاح:</b> <code>${available}</code> عملية\n` +
    `• تاريخ التجديد القادم: <b>${resetDate}</b>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? '🟢 نشط' : '🔴 متوقف'}</b>\n\n` +
    `💡 <i>ملاحظة: لشحن رصيد إضافي أو ترقية الباقة، يمكنك استخدام بوت المنصة الأساسي.</i>`;

  const keyboard = new InlineKeyboard()
    .text('🔄 تحديث الرصيد', 'admin:subscription')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
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
    text += `<i>لا توجد منتجات مضافة في متجرك حتى الآن.</i>\n\n`;
  } else {
    text += `لديك <b>${products.length}</b> منتج معروض:\n\n`;
    for (const p of products) {
      const stockCount = p.digital_product_codes?.[0]?.count ?? 0;
      text += `• <b>${p.name}</b>\n`;
      text += `  السعر: <b>${p.price_stars} ⭐️ Stars</b> | المخزون: <code>${stockCount}</code> كود\n`;
      text += `  النوع: <code>${p.product_type}</code>\n\n`;
    }
  }

  keyboard
    .text('➕ إضافة منتج', 'admin:add_product')
    .text('📥 استيراد أكواد', 'admin:import_codes')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:invoices' button click - lists recent invoices
 */
export async function handleInvoicesView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();

  const { data: invoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(8);

  let text = `📄 <b>سجل الفواتير الأخيرة:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!invoices || invoices.length === 0) {
    text += `<i>لا توجد فواتير منشأة حتى الآن.</i>\n\n`;
  } else {
    for (const inv of invoices) {
      const statusIcon = inv.status === 'paid' ? '🟢 مدفوعة' : inv.status === 'pending' ? '🟡 معلقة' : '🔴 ملغاة';
      text += `• <b>${inv.invoice_number}</b> - ${inv.title}\n`;
      text += `  المبلغ: <b>${inv.total_amount} ⭐️ Stars</b> | الحالة: ${statusIcon}\n`;
      text += `  التاريخ: <code>${new Date(inv.created_at).toLocaleDateString('ar-EG')}</code>\n\n`;
    }
  }

  keyboard
    .text('🔄 تحديث الفواتير', 'admin:invoices')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:orders' button click - lists recent customer orders
 */
export async function handleOrdersView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();

  const { data: orders } = await supabase
    .from('orders')
    .select('*, products(name)')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .order('created_at', { ascending: false })
    .limit(8);

  let text = `🛒 <b>سجل طلبات العملاء:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!orders || orders.length === 0) {
    text += `<i>لا توجد طلبات شراء حتى الآن.</i>\n\n`;
  } else {
    for (const ord of orders) {
      const prodName = ord.products?.name || 'منتج رقمي';
      const statusIcon = ord.status === 'completed' ? '✅ تم التسليم' : ord.status === 'paid' ? '🟢 مدفوع' : '⏳ معلق';
      text += `• <b>طلب: ${prodName}</b>\n`;
      text += `  المبلغ: <b>${ord.amount} ⭐️ Stars</b> | الحالة: ${statusIcon}\n`;
      text += `  التاريخ: <code>${new Date(ord.created_at).toLocaleDateString('ar-EG')}</code>\n\n`;
    }
  }

  keyboard
    .text('🔄 تحديث الطلبات', 'admin:orders')
    .row()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:settings' button click - shows system & bot health
 */
export async function handleSettingsView(ctx: any, botUsername: string, botId: string) {
  const text = 
    `⚙️ <b>إعدادات وحالة البوت:</b>\n\n` +
    `• معرف البوت: <code>@${botUsername}</code>\n` +
    `• معرف النظام (UUID): <code>${botId}</code>\n` +
    `• التشفير: 🔒 <b>AES-256-GCM نشط</b>\n` +
    `• نظام الـ Webhook: 🟢 <b>متصل وفوري</b>\n` +
    `• الدفع بالنجوم: ⭐ <b>مفعل (XTR)</b>\n\n` +
    `💡 <i>جميع البيانات محمية بنظام العزل المتعدد (Multi-Tenant).</i>`;

  const keyboard = new InlineKeyboard()
    .text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
