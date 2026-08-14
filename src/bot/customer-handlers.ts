import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';

/**
 * Handles regular customer interaction when accessing the Merchant Bot
 */
export async function renderCustomerHome(ctx: any, merchantId: string, botId: string, botUsername: string) {
  const supabase = getSupabase();
  const from = ctx.from;
  if (!from) return;

  // 1. Upsert customer in database
  await supabase
    .from('customers')
    .upsert({
      merchant_id: merchantId,
      telegram_user_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'merchant_id,telegram_user_id' });

  // 2. Check if customer has any pending invoices
  const { data: pendingInvoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .eq('status', 'pending')
    .is('deleted_at', null)
    .limit(3);

  let text = `مرحباً بك <b>${from.first_name || 'عزيزي العميل'}</b> في متجرنا 🛍️\n\n`;

  const keyboard = new InlineKeyboard();

  if (pendingInvoices && pendingInvoices.length > 0) {
    text += `⚠️ <b>لديك فواتير بانتظار الدفع:</b>\n`;
    for (const inv of pendingInvoices) {
      text += `• <b>${inv.title}</b> (${inv.total_amount} ⭐️ Stars) - كود: <code>${inv.invoice_number}</code>\n`;
      keyboard.text(`💳 سداد: ${inv.title}`, `pay:inv:${inv.id}`).row();
    }
    text += `\n`;
  }

  text += `يمكنك تصفح المنتجات الرقمية المتوفرة عبر الزر أدناه:`;
  keyboard.text('📦 تصفح المنتجات المتوفرة', 'cust:catalog').row();

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles customer catalog browsing
 */
export async function renderCustomerCatalog(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .eq('is_active', true)
    .is('deleted_at', null);

  if (!products || products.length === 0) {
    const emptyKeyboard = new InlineKeyboard().text('🔙 العودة', 'cust:home');
    const msg = '📦 لا توجد منتجات معروضة حالياً في المتجر. يرجى مراجعتنا لاحقاً!';
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { reply_markup: emptyKeyboard });
    } else {
      await ctx.reply(msg, { reply_markup: emptyKeyboard });
    }
    return;
  }

  let text = `📦 <b>المنتجات الرقمية المتوفرة:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  for (const prod of products) {
    text += `• <b>${prod.name}</b> - <code>${prod.price_stars} ⭐️ Stars</code>\n`;
    if (prod.description) {
      text += `  <i>${prod.description}</i>\n`;
    }
    keyboard.text(`🛒 شراء ${prod.name} (${prod.price_stars} ⭐️)`, `buy:prod:${prod.id}`).row();
  }

  keyboard.text('🔙 الرئيسية', 'cust:home');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
