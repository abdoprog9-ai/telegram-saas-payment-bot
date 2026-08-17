import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { getMerchantSettings } from '../services/settings-service.js';

/**
 * Handles regular customer interaction when accessing the Merchant Bot (Pure Invoicing Portal + Dual-Mode Admin Switch)
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

  // 2. Fetch merchant settings and pending invoices for this customer
  const [settings, pendingInvoicesRes] = await Promise.all([
    getMerchantSettings(merchantId),
    supabase
      .from('invoices')
      .select('*')
      .eq('merchant_id', merchantId)
      .eq('bot_id', botId)
      .eq('status', 'pending')
      .is('deleted_at', null)
      .limit(5),
  ]);

  const pendingInvoices = pendingInvoicesRes.data;
  const bizTitle = settings.business_name || 'بوابة الدفع والفواتير';

  let text = '';
  if (settings.custom_welcome_msg) {
    text += `<b>${settings.custom_welcome_msg}</b>\n\n`;
  } else {
    text += `مرحباً بك <b>${from.first_name || 'عزيزي العميل'}</b> في <b>${bizTitle}</b> 💳\n\n`;
  }

  const keyboard = new InlineKeyboard();

  if (pendingInvoices && pendingInvoices.length > 0) {
    text += `<b>الفواتير بانتظار السداد:</b>\n\n`;
    for (const inv of pendingInvoices) {
      text += `• <b>${inv.title}</b> (<b>${inv.total_amount} ⭐️ Stars</b>)\n`;
      text += `  رقم الفاتورة: <code>${inv.invoice_number}</code>\n\n`;
      keyboard.text(`⭐️ سداد فاتورة ${inv.invoice_number}`, `pay:inv:${inv.id}`).row();
    }
  } else {
    text += `<b>كيفية سداد الفواتير:</b>\n`;
    text += `• أرسل <b>رقم الفاتورة</b> مباشرة في هذه المحادثة (مثال: <code>INV-XXXXXX</code>) ليظهر لك أمر الدفع فورياً.\n`;
    text += `• أو افتح رابط الفاتورة المباشر المرسل لك لسدادها بنجوم تيليجرام في ثوانٍ معدودة. ⭐️\n`;
  }

  // Support link button if configured
  if (settings.support_username) {
    const cleanSupport = settings.support_username.replace('@', '');
    keyboard.url('💬 الدعم والمساعدة', `https://t.me/${cleanSupport}`).row();
  }

  // Dual-mode Admin Switch button (Visible to all, protected for owner only)
  keyboard.text('⚙️ لوحة الإدارة', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles customer catalog browsing fallback
 */
export async function renderCustomerCatalog(ctx: any, merchantId: string, botId: string) {
  return renderCustomerHome(ctx, merchantId, botId, '');
}
