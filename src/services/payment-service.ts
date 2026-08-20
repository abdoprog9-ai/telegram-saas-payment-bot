import { Api } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { Invoice, Refund } from '../types/index.js';
import { getMerchantSettings } from './settings-service.js';

export interface CompactPayload {
  i: string; // invoiceId
  o?: string; // orderId
  p?: string; // productId
}

export interface SuccessfulPaymentEventData {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
}

/**
 * Parses compact invoice payload (< 128 bytes limit enforced by Telegram)
 */
export function parseInvoicePayload(rawPayload: string): {
  invoiceId: string;
  orderId?: string;
  productId?: string;
} {
  try {
    const parsed = JSON.parse(rawPayload);
    return {
      invoiceId: parsed.i || parsed.invoiceId,
      orderId: parsed.o || parsed.orderId,
      productId: parsed.p || parsed.productId,
    };
  } catch {
    const cleaned = rawPayload.replace('inv:', '').trim();
    return { invoiceId: cleaned };
  }
}

/**
 * Sends a Telegram Stars (XTR) Invoice directly to a customer in chat
 */
export async function sendTelegramStarsInvoice(
  api: Api,
  chatId: number,
  invoice: Invoice,
  extraPayload?: { orderId?: string; productId?: string }
): Promise<any> {
  const compactData: CompactPayload = {
    i: invoice.id,
    o: extraPayload?.orderId,
    p: extraPayload?.productId,
  };

  const payloadStr = JSON.stringify(compactData);

  const safeTitle = invoice.title.slice(0, 32);
  const safeDescription = (invoice.description || `سداد فاتورة رقم: ${invoice.invoice_number}`).slice(0, 255);

  return await api.sendInvoice(
    chatId,
    safeTitle,
    safeDescription,
    payloadStr,
    'XTR',
    [
      {
        label: safeTitle,
        amount: invoice.total_amount,
      },
    ]
  );
}

/**
 * Handles pre_checkout_query: checks invoice status before allowing Telegram to charge Stars
 */
export async function handlePreCheckoutQuery(api: Api, preCheckoutQuery: any): Promise<boolean> {
  const supabase = getSupabase();
  const { invoiceId } = parseInvoicePayload(preCheckoutQuery.invoice_payload);

  if (!invoiceId) {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'بيانات الفاتورة غير صالحة.',
    });
    return false;
  }

  // 1. Verify Invoice is still pending
  const { data: inv } = await supabase
    .from('invoices')
    .select('id, status, total_amount, expires_at')
    .eq('id', invoiceId)
    .single();

  if (!inv || inv.status !== 'pending') {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'هذه الفاتورة مدفوعة مسبقاً أو غير متاحة حالياً.',
    });
    return false;
  }

  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'عذراً، انتهت صلاحية هذه الفاتورة.',
    });
    return false;
  }

  // Pre-checkout approved!
  await api.answerPreCheckoutQuery(preCheckoutQuery.id, true);
  return true;
}

/**
 * Handles successful_payment: Executes atomic idempotent payment registration, merchant settings custom notes, and merchant notification
 */
export async function handleSuccessfulPayment(
  api: Api,
  chatId: number,
  customerTelegramId: number,
  successfulPayment: SuccessfulPaymentEventData
): Promise<{ success: boolean }> {
  const supabase = getSupabase();
  const { invoiceId, orderId, productId } = parseInvoicePayload(successfulPayment.invoice_payload);

  if (!invoiceId) {
    throw new Error('Missing invoice payload in successful payment');
  }

  // Fetch full invoice record
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .single();

  if (invErr || !invoice) {
    throw new Error(`Invoice record not found: ${invoiceId}`);
  }

  const { bot_id: botId, merchant_id: merchantId } = invoice;
  const chargeId = successfulPayment.telegram_payment_charge_id;
  const amount = successfulPayment.total_amount;

  // 1. Execute Atomic Idempotent SQL Function
  const { error: rpcError } = await supabase.rpc('process_successful_payment_idempotent', {
    p_bot_id: botId,
    p_merchant_id: merchantId,
    p_invoice_id: invoiceId,
    p_order_id: orderId || null,
    p_telegram_charge_id: chargeId,
    p_amount: amount,
    p_product_id: productId || null,
    p_payload: successfulPayment,
  });

  if (rpcError) {
    // Fallback updates
    await supabase.from('payments').upsert({
      invoice_id: invoiceId,
      merchant_id: merchantId,
      provider: 'telegram_stars',
      telegram_charge_id: chargeId,
      amount,
      currency: 'XTR',
      status: 'successful',
      raw_payload: successfulPayment,
    }, { onConflict: 'telegram_charge_id' });

    await supabase.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', invoiceId);
  }

  // 2. Fetch Merchant Settings for Custom Thank You Message & Notification Preferences
  const settings = await getMerchantSettings(merchantId);

  // 3. Deliver Confirmation Note to Customer
  let customerMsg = `<b>تم تأكيد دفعك بنجاح</b>\n\n`;
  customerMsg += `• الفاتورة: <b>${invoice.title}</b> (<code>${invoice.invoice_number}</code>)\n`;
  customerMsg += `• المبلغ المسدد: <b>${amount} ⭐️ Stars</b>\n`;
  customerMsg += `• رقم المعاملة: <code>${chargeId}</code>\n\n`;

  if (settings.custom_thankyou_msg) {
    customerMsg += `<b>رسالة من التاجر:</b>\n${settings.custom_thankyou_msg}\n\n`;
  } else {
    customerMsg += `شكراً لتعاملك معنا! تم إشعار صاحب المتجر بإتمام العملية.\n`;
  }

  await api.sendMessage(chatId, customerMsg, { parse_mode: 'HTML' });

  // 4. Notify Merchant Owner (if enabled in settings)
  if (settings.notify_on_payment !== false) {
    const { data: merchantBot } = await supabase
      .from('telegram_bots')
      .select('*, merchants!inner(users!inner(telegram_user_id))')
      .eq('id', botId)
      .single();

    const merchantTgId = merchantBot?.merchants?.users?.telegram_user_id;
    if (merchantTgId) {
      const notifyText =
        `<b>إشعار عملية سداد جديدة</b>\n\n` +
        `• الفاتورة: <b>${invoice.title}</b> (<code>${invoice.invoice_number}</code>)\n` +
        `• المبلغ المستلم: <b>${amount} ⭐️ Stars</b>\n` +
        `• رقم المعاملة: <code>${chargeId}</code>\n` +
        `• معرف العميل: <code>${customerTelegramId}</code>`;

      await api.sendMessage(merchantTgId, notifyText, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  return { success: true };
}

/**
 * Simulates a successful test payment (Sandbox mode) without charging real Stars
 */
export async function simulateTestPayment(
  api: Api,
  chatId: number,
  customerTelegramId: number,
  invoiceId: string
): Promise<{ success: boolean; chargeId: string }> {
  const supabase = getSupabase();

  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .single();

  if (error || !invoice) {
    throw new Error('الفاتورة غير موجودة.');
  }

  if (invoice.status === 'paid') {
    throw new Error('هذه الفاتورة مدفوعة مسبقاً.');
  }

  const testChargeId = `sandbox_${Date.now()}_${invoice.id.slice(0, 8)}`;

  // 1. Record payment in payments table
  await supabase.from('payments').upsert({
    invoice_id: invoiceId,
    merchant_id: invoice.merchant_id,
    provider: 'test_sandbox',
    telegram_charge_id: testChargeId,
    amount: invoice.total_amount,
    currency: 'XTR',
    status: 'successful',
    raw_payload: { simulated: true, invoiceId, customerTelegramId },
  }, { onConflict: 'telegram_charge_id' });

  // 2. Update invoice status to paid
  await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', invoiceId);

  // 3. Deduct operation from usage
  const { data: usage } = await supabase
    .from('usage')
    .select('operations_used')
    .eq('merchant_id', invoice.merchant_id)
    .single();

  if (usage) {
    await supabase
      .from('usage')
      .update({
        operations_used: (usage.operations_used || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('merchant_id', invoice.merchant_id);
  }

  // 4. Fetch Merchant Settings
  const settings = await getMerchantSettings(invoice.merchant_id);

  // 5. Send Confirmation to Customer
  let customerMsg = `🧪 <b>تم سداد الفاتورة تجريبياً بنجاح (Sandbox Mode)</b>\n\n`;
  customerMsg += `• الفاتورة: <b>${invoice.title}</b> (<code>${invoice.invoice_number}</code>)\n`;
  customerMsg += `• المبلغ: <b>${invoice.total_amount} ⭐️ Stars</b>\n`;
  customerMsg += `• رقم المعاملة التجريبية: <code>${testChargeId}</code>\n\n`;

  if (settings.custom_thankyou_msg) {
    customerMsg += `<b>رسالة التاجر للعميل:</b>\n${settings.custom_thankyou_msg}\n\n`;
  } else {
    customerMsg += `شكراً لك! هذه عملية محاكاة تجريبية وتم تحديث حالة الفاتورة وإشعار التاجر بنجاح.\n`;
  }

  await api.sendMessage(chatId, customerMsg, { parse_mode: 'HTML' });

  // 6. Notify Merchant Owner
  if (settings.notify_on_payment !== false) {
    const { data: merchantBot } = await supabase
      .from('telegram_bots')
      .select('*, merchants!inner(users!inner(telegram_user_id))')
      .eq('id', invoice.bot_id)
      .single();

    const merchantTgId = merchantBot?.merchants?.users?.telegram_user_id;
    if (merchantTgId) {
      const notifyText =
        `🧪 <b>إشعار سداد تجريبي جديد (Sandbox Alert)</b>\n\n` +
        `• الفاتورة: <b>${invoice.title}</b> (<code>${invoice.invoice_number}</code>)\n` +
        `• المبلغ: <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
        `• رقم المعاملة: <code>${testChargeId}</code>\n` +
        `• معرف العميل: <code>${customerTelegramId}</code>\n\n` +
        `<i>تم تسجيل الفاتورة كمدفوعة واحتساب عملية الاستهلاك بنجاح.</i>`;

      await api.sendMessage(merchantTgId, notifyText, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  return { success: true, chargeId: testChargeId };
}

/**
 * Refunds a Telegram Stars Payment via Telegram API and updates database
 */
export async function refundTelegramStarsPayment(
  api: Api,
  userId: number,
  telegramChargeId: string,
  merchantId: string,
  reason?: string
): Promise<Refund> {
  const supabase = getSupabase();

  const { data: payment, error: payErr } = await supabase
    .from('payments')
    .select('*, invoices(*)')
    .eq('telegram_charge_id', telegramChargeId)
    .eq('merchant_id', merchantId)
    .single();

  if (payErr || !payment) {
    throw new Error('Payment record not found');
  }

  // If real stars payment, call Telegram refund API
  if (payment.provider !== 'test_sandbox') {
    await api.refundStarPayment(userId, telegramChargeId);
  }

  const { data: newRefund, error: refErr } = await supabase
    .from('refunds')
    .insert({
      payment_id: payment.id,
      merchant_id: merchantId,
      amount: payment.amount,
      reason: reason || 'Merchant initiated refund',
      telegram_refund_id: `ref_${Date.now()}`,
      status: 'completed',
    })
    .select()
    .single();

  if (refErr || !newRefund) {
    throw new Error(`Database error recording refund: ${refErr?.message}`);
  }

  await supabase
    .from('invoices')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', payment.invoice_id);

  return newRefund;
}
