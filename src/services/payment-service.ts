import { Api } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { Invoice, Refund } from '../types/index.js';

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
  // Telegram payload has a STRICT 128-byte limit!
  const compactData: CompactPayload = {
    i: invoice.id,
    o: extraPayload?.orderId,
    p: extraPayload?.productId,
  };

  const payloadStr = JSON.stringify(compactData);

  // Telegram title max 32 chars, description max 255 chars
  const safeTitle = invoice.title.slice(0, 32);
  const safeDescription = (invoice.description || `سداد فاتورة رقم: ${invoice.invoice_number}`).slice(0, 255);

  return await api.sendInvoice(
    chatId,
    safeTitle,
    safeDescription,
    payloadStr,
    'XTR', // Telegram Stars currency
    [
      {
        label: safeTitle,
        amount: invoice.total_amount, // Stars amount
      },
    ]
  );
}

/**
 * Handles pre_checkout_query: checks inventory before allowing Telegram to charge Stars
 */
export async function handlePreCheckoutQuery(api: Api, preCheckoutQuery: any): Promise<boolean> {
  const supabase = getSupabase();
  const { invoiceId, productId } = parseInvoicePayload(preCheckoutQuery.invoice_payload);

  if (!invoiceId) {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'بيانات الفاتورة غير صالحة.',
    });
    return false;
  }

  // 1. Verify Invoice is still pending
  const { data: inv } = await supabase
    .from('invoices')
    .select('id, status, total_amount')
    .eq('id', invoiceId)
    .single();

  if (!inv || inv.status !== 'pending') {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'هذه الفاتورة مدفوعة مسبقاً أو غير متاحة حالياً.',
    });
    return false;
  }

  // 2. If it is a digital code product, check if inventory is available
  if (productId) {
    const { count: availCount } = await supabase
      .from('digital_product_codes')
      .select('id', { count: 'exact' })
      .eq('product_id', productId)
      .eq('is_used', false);

    if (!availCount || availCount <= 0) {
      await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
        error_message: 'نعتذر منك، نفد مخزون هذا المنتج الرقمي حالياً.',
      });
      return false;
    }
  }

  // Pre-checkout approved!
  await api.answerPreCheckoutQuery(preCheckoutQuery.id, true);
  return true;
}

/**
 * Handles successful_payment: Executes atomic idempotent payment registration, code delivery, and merchant notification
 */
export async function handleSuccessfulPayment(
  api: Api,
  chatId: number,
  customerTelegramId: number,
  successfulPayment: SuccessfulPaymentEventData
): Promise<{ success: boolean; deliveredCode?: string | null }> {
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
  const { data: rpcResult, error: rpcError } = await supabase.rpc('process_successful_payment_idempotent', {
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
    if (orderId) {
      await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);
    }
  }

  const deliveredCode = rpcResult?.[0]?.delivered_code;

  // 2. Deliver code/content to Customer in Telegram Chat
  let customerMsg = `🎉 <b>تم تأكيد دفعك بنجاح!</b>\n\n`;
  customerMsg += `• الفاتورة: <b>${invoice.title}</b> (<code>${invoice.invoice_number}</code>)\n`;
  customerMsg += `• المبلغ: <b>${amount} ⭐️ Stars</b>\n`;
  customerMsg += `• رقم المعاملة: <code>${chargeId}</code>\n\n`;

  if (deliveredCode) {
    customerMsg += `📦 <b>بيانات المنتج الرقمي الخاص بك:</b>\n`;
    customerMsg += `<code>${deliveredCode}</code>\n\n`;
    customerMsg += `<i>(احتفظ بهذا الكود، تم استهلاكه وتسليمه لك حصرياً).</i>`;
  } else {
    customerMsg += `شكراً لتعاملك معنا! تم إشعار صاحب المتجر بإتمام العملية.`;
  }

  await api.sendMessage(chatId, customerMsg, { parse_mode: 'HTML' });

  // 3. Notify Merchant Owner
  const { data: merchantBot } = await supabase
    .from('telegram_bots')
    .select('*, merchants!inner(users!inner(telegram_user_id))')
    .eq('id', botId)
    .single();

  const merchantTgId = merchantBot?.merchants?.users?.telegram_user_id;
  if (merchantTgId) {
    const notifyText =
      `🔔 <b>إشعار عملية بيع وفاتورة مسددة!</b>\n\n` +
      `• الفاتورة: <b>${invoice.title}</b> (<code>${invoice.invoice_number}</code>)\n` +
      `• المبلغ المستلم: <b>${amount} ⭐️ Stars</b>\n` +
      `• رقم المعاملة: <code>${chargeId}</code>\n` +
      `• معرف العميل: <code>${customerTelegramId}</code>`;

    await api.sendMessage(merchantTgId, notifyText, { parse_mode: 'HTML' }).catch(() => {});
  }

  return {
    success: true,
    deliveredCode,
  };
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

  // 1. Fetch Payment Record
  const { data: payment, error: payErr } = await supabase
    .from('payments')
    .select('*, invoices(*)')
    .eq('telegram_charge_id', telegramChargeId)
    .eq('merchant_id', merchantId)
    .single();

  if (payErr || !payment) {
    throw new Error('Payment record not found');
  }

  // 2. Call Telegram Bot API refundStarPayment
  await api.refundStarPayment(userId, telegramChargeId);

  // 3. Create Refund record in DB
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

  // 4. Update Invoice Status to Refunded
  await supabase
    .from('invoices')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', payment.invoice_id);

  return newRefund;
}
