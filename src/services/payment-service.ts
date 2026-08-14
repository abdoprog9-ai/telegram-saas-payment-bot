import { Api } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { Invoice, Payment, Refund } from '../types/index.js';

export interface InvoicePayloadData {
  invoiceId: string;
  orderId?: string;
  productId?: string;
  merchantId: string;
  botId: string;
}

export interface SuccessfulPaymentEventData {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
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
  const payloadData: InvoicePayloadData = {
    invoiceId: invoice.id,
    orderId: extraPayload?.orderId,
    productId: extraPayload?.productId,
    merchantId: invoice.merchant_id,
    botId: invoice.bot_id,
  };

  // Telegram Stars uses ISO currency code 'XTR'
  return await api.sendInvoice(
    chatId,
    invoice.title,
    invoice.description || `سداد فاتورة رقم: ${invoice.invoice_number}`,
    JSON.stringify(payloadData),
    'XTR', // Telegram Stars currency
    [
      {
        label: invoice.title.slice(0, 30),
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
  let payload: InvoicePayloadData | null = null;

  try {
    payload = JSON.parse(preCheckoutQuery.invoice_payload);
  } catch {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'بيانات الفاتورة غير صالحة.',
    });
    return false;
  }

  if (!payload || !payload.invoiceId) {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'تعذر التحقق من الفاتورة.',
    });
    return false;
  }

  // 1. Verify Invoice is still pending
  const { data: inv } = await supabase
    .from('invoices')
    .select('id, status, total_amount')
    .eq('id', payload.invoiceId)
    .single();

  if (!inv || inv.status !== 'pending') {
    await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
      error_message: 'هذه الفاتورة مدفوعة مسبقاً أو غير متاحة حالياً.',
    });
    return false;
  }

  // 2. If it is a digital code product, check if inventory is available
  if (payload.productId) {
    const { count: availCount } = await supabase
      .from('digital_product_codes')
      .select('id', { count: 'exact' })
      .eq('product_id', payload.productId)
      .eq('is_used', false);

    if (!availCount || availCount <= 0) {
      await api.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
        error_message: 'نعتذر منك، نفد مخزون هذا المنتج الرقمي حالياً.',
      });
      return false;
    }
  }

  // Pre-checkout approved! Telegram will now process Stars payment.
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
  let payload: InvoicePayloadData | null = null;

  try {
    payload = JSON.parse(successfulPayment.invoice_payload);
  } catch {
    throw new Error('Invalid invoice payload structure in successful payment');
  }

  if (!payload) {
    throw new Error('Missing invoice payload');
  }

  const { botId, merchantId, invoiceId, orderId, productId } = payload;
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
    // If DB RPC error, execute direct fallback updates
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

  // 3. Notify Merchant Owner if merchant telegram ID exists
  const { data: merchantBot } = await supabase
    .from('telegram_bots')
    .select('*, merchants!inner(users!inner(telegram_user_id))')
    .eq('id', botId)
    .single();

  const merchantTgId = merchantBot?.merchants?.users?.telegram_user_id;
  if (merchantTgId) {
    const notifyText =
      `🔔 <b>إشعار عملية بيع جديدة ناجحة!</b>\n\n` +
      `• المبلغ: <b>${amount} ⭐️ Stars</b>\n` +
      `• رقم المعاملة: <code>${chargeId}</code>\n` +
      `• العميل: ID <code>${customerTelegramId}</code>\n` +
      `• الفاتورة: <code>${invoiceId}</code>`;

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
