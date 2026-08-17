import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';

/**
 * Handles regular customer interaction when accessing the Merchant Bot (Pure Invoicing Portal)
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

  // 2. Check if customer has any pending invoices in this bot
  const { data: pendingInvoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .eq('status', 'pending')
    .is('deleted_at', null)
    .limit(5);

  let text = `مرحباً بك <b>${from.first_name || 'عزيزي العميل'}</b> في بوابة الدفع والفواتير 💳\n\n`;
  const keyboard = new InlineKeyboard();

  if (pendingInvoices && pendingInvoices.length > 0) {
    text += `📋 <b>لديك فواتير مستحقة الدفع:</b>\n\n`;
    for (const inv of pendingInvoices) {
      text += `• <b>${inv.title}</b> (<b>${inv.total_amount} ⭐️ Stars</b>)\n`;
      text += `  رقم الفاتورة: <code>${inv.invoice_number}</code>\n\n`;
      keyboard.text(`⭐️ سداد فاتورة ${inv.invoice_number}`, `pay:inv:${inv.id}`).row();
    }
  } else {
    text += `💡 <b>كيفية سداد الفواتير:</b>\n`;
    text += `• يمكنك إرسال <b>رقم الفاتورة</b> مباشرة في هذه المحادثة (مثال: <code>INV-XXXXXX</code>) ليظهر لك أمر الدفع فورياً.\n`;
    text += `• أو اضغط على رابط الفاتورة المباشر المرسل لك من صاحب المتجر لسدادها بنجوم تيليجرام في ثوانٍ معدودة! ⭐️\n`;
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles customer catalog browsing (kept for backward-compatibility if invoked)
 */
export async function renderCustomerCatalog(ctx: any, merchantId: string, botId: string) {
  return renderCustomerHome(ctx, merchantId, botId, '');
}
