import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { createInvoice } from '../services/invoice-service.js';
import { getMerchantSettings, updateMerchantSettings } from '../services/settings-service.js';
import { getPlatformBotUsername } from './platform-bot.js';

export interface AdminSession {
  step:
    | 'invoice_title'
    | 'invoice_amount'
    | 'set_biz_name'
    | 'set_welcome_msg'
    | 'set_thankyou_msg'
    | 'set_support_user';
  data: {
    merchantId: string;
    botId: string;
    botUsername: string;
    invoiceTitle?: string;
    invoiceAmount?: number;
  };
}

// In-Memory Session Store for Admin Invoicing & Settings Wizards
const adminSessions = new Map<number, AdminSession>();

export function getAdminSession(userId: number): AdminSession | undefined {
  return adminSessions.get(userId);
}

export function setAdminSession(userId: number, session: AdminSession) {
  adminSessions.set(userId, session);
}

export function clearAdminSession(userId: number) {
  adminSessions.delete(userId);
}

/**
 * Builds the Main Admin Dashboard Inline Keyboard
 */
export function buildAdminMainMenu(platformUsername?: string, merchantId?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('إنشاء فاتورة جديدة', 'admin:create_invoice')
    .row()
    .text('سجل الفواتير', 'admin:invoices')
    .text('الإحصائيات والتقارير', 'admin:analytics')
    .row();

  if (platformUsername && merchantId) {
    const subUrl = `https://t.me/${platformUsername.replace('@', '')}?start=sub_${merchantId}`;
    kb.url('شحن الرصيد / تجديد الاشتراك', subUrl).row();
  }

  kb.text('إعدادات المتجر', 'admin:settings')
    .text('الاشتراك والرصيد', 'admin:subscription')
    .row()
    .text('معاينة كعميل', 'cust:home')
    .text('تحديث', 'admin:refresh');

  return kb;
}

/**
 * Handles the Main Merchant Dashboard
 */
export async function renderAdminDashboard(ctx: any, merchantId: string, botUsername: string, isRefresh = false) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  // Parallel data fetching
  const [usageRes, subRes, realInvoicesRes, realPaidInvoicesRes, testInvoicesRes, settings, platformUsername] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
    supabase.from('invoices').select('id', { count: 'exact' }).eq('merchant_id', merchantId).eq('is_test', false).is('deleted_at', null),
    supabase.from('invoices').select('id, total_amount').eq('merchant_id', merchantId).eq('is_test', false).eq('status', 'paid').is('deleted_at', null),
    supabase.from('invoices').select('id', { count: 'exact' }).eq('merchant_id', merchantId).eq('is_test', true).is('deleted_at', null),
    getMerchantSettings(merchantId),
    getPlatformBotUsername(),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const planName = sub?.plans?.name || 'Free Starter';

  const base = usage?.base_operations ?? 10;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  const realTotalInvoices = realInvoicesRes.count ?? 0;
  const realPaidList = realPaidInvoicesRes.data || [];
  const realPaidCount = realPaidList.length;
  const realTotalRevenue = realPaidList.reduce((acc, inv) => acc + (inv.total_amount || 0), 0);
  const testTotalInvoices = testInvoicesRes.count ?? 0;

  const displayName = settings.business_name || `@${botUsername}`;
  const modeBadge = settings.test_mode !== false ? '🟡 وضع الاختبار التجريبي (Sandbox)' : '🟢 وضع التشغيل المباشر (Live)';

  let text =
    `<b>لوحة إدارة المتجر | ${displayName}</b>\n\n` +
    `• وضع النظام: <b>${modeBadge}</b>\n` +
    `• الخطة الحالية: <b>${planName}</b>\n` +
    `• الرصيد المتاح: <b>${available}</b> عملية (المستهلك: <code>${used}</code>)\n` +
    `• الرصيد الإضافي: <b>${bonus}</b>\n` +
    `• حالة الحساب: <b>${sub?.status === 'active' ? 'نشط' : 'متوقف'}</b>\n\n` +
    `<b>المؤشرات المالية (الرسمية):</b>\n` +
    `• الفواتير الحقيقية: <b>${realTotalInvoices}</b> (المسددة: <b>${realPaidCount}</b>)\n` +
    `• إجمالي الإيراد المحصل: <b>${realTotalRevenue} ⭐️ Stars</b>\n`;

  if (settings.test_mode) {
    text += `\n<i>[فواتير الساندبوكس التجريبية: ${testTotalInvoices} (معزولة بالكامل ولا تحتسب في الإيراد)]</i>\n`;
  }

  const keyboard = buildAdminMainMenu(platformUsername, merchantId);

  if (isRefresh && ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: 'تم تحديث البيانات' }).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:invoices' view
 */
export async function handleInvoicesView(ctx: any, merchantId: string, botId: string) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  const { data: invoices } = await supabase
    .from('invoices')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('bot_id', botId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(10);

  let text = `<b>سجل الفواتير:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!invoices || invoices.length === 0) {
    text += `<i>لا توجد فواتير منشأة حالياً.</i>\n\n`;
  } else {
    text += `اضغط على أي فاتورة لاستعراض تفاصيلها ورابط السداد:\n\n`;
    for (const inv of invoices) {
      const statusLabel = inv.status === 'paid' ? 'مسددة' : inv.status === 'pending' ? 'معلقة' : 'ملغاة';
      const badge = inv.is_test ? '🟡 [تجريبية]' : '🟢 [رسمية]';
      keyboard.text(`${badge} ${inv.invoice_number} | ${inv.title} (${inv.total_amount}⭐️) [${statusLabel}]`, `admin:view_inv:${inv.id}`).row();
    }
  }

  keyboard
    .text('إنشاء فاتورة جديدة', 'admin:create_invoice')
    .row()
    .text('تحديث القائمة', 'admin:invoices')
    .text('الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders full details for a specific invoice
 */
export async function renderInvoiceDetail(ctx: any, invoiceId: string, merchantId: string, botUsername: string) {
  const supabase = getSupabase();
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('merchant_id', merchantId)
    .single();

  if (!invoice || invoice.deleted_at) {
    const text = `عذراً، هذه الفاتورة غير موجودة أو تم حذفها مسبقاً.`;
    const kb = new InlineKeyboard().text('سجل الفواتير', 'admin:invoices');
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  const directPayLink = `https://t.me/${botUsername}?start=inv_${invoice.id}`;
  const statusLabel = invoice.status === 'paid' ? 'مسددة بنجاح' : invoice.status === 'pending' ? 'بانتظار السداد' : 'ملغاة';
  const typeBadge = invoice.is_test ? '🟡 تجريبية (Sandbox - معزولة لا تخصم رصيد ولا إيراد)' : '🟢 رسمية (Live Production)';
  const createdDate = new Date(invoice.created_at).toLocaleString('ar-EG');
  const paidDate = invoice.paid_at ? new Date(invoice.paid_at).toLocaleString('ar-EG') : null;

  let text =
    `<b>تفاصيل الفاتورة: ${invoice.invoice_number}</b>\n\n` +
    `• البيان: <b>${invoice.title}</b>\n` +
    (invoice.description ? `• التفاصيل: ${invoice.description}\n` : '') +
    `• المبلغ: <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
    `• الحالة: <b>${statusLabel}</b>\n` +
    `• نوع الفاتورة: <b>${typeBadge}</b>\n` +
    `• تاريخ الإنشاء: <code>${createdDate}</code>\n` +
    (paidDate ? `• تاريخ السداد: <code>${paidDate}</code>\n` : '') +
    `\n<b>رابط السداد:</b>\n<code>${directPayLink}</code>\n`;

  const keyboard = new InlineKeyboard()
    .url('فتح رابط الفاتورة', directPayLink)
    .row();

  if (invoice.status === 'pending') {
    keyboard
      .text('تجربة السداد', `pay:inv:${invoice.id}`)
      .text('إلغاء الفاتورة', `admin:del_inv:${invoice.id}`)
      .row();
  }

  keyboard
    .text('سجل الفواتير', 'admin:invoices')
    .text('الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles soft deleting / canceling an invoice
 */
export async function handleDeleteInvoice(ctx: any, invoiceId: string, merchantId: string, botId: string) {
  const supabase = getSupabase();
  await supabase
    .from('invoices')
    .update({
      status: 'cancelled',
      deleted_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .eq('merchant_id', merchantId);

  if (ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: 'تم إلغاء الفاتورة' }).catch(() => {});
  }

  await handleInvoicesView(ctx, merchantId, botId);
}

/**
 * Starts the Streamlined Create Invoice Wizard
 */
export async function startCreateInvoiceWizard(ctx: any, merchantId: string, botId: string, botUsername: string) {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  setAdminSession(fromId, {
    step: 'invoice_title',
    data: { merchantId, botId, botUsername },
  });

  const text =
    `<b>إنشاء فاتورة جديدة (1/2):</b>\n\n` +
    `أدخل عنوان أو بيان الفاتورة (مثال: اشتراك شهر / استشارة / خدمة تطوير):`;

  const keyboard = new InlineKeyboard().text('إلغاء', 'admin:cancel_wizard');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:settings' view
 */
export async function handleSettingsView(ctx: any, merchantId: string, botUsername: string, botId: string) {
  const settings = await getMerchantSettings(merchantId);

  const bizName = settings.business_name || 'الافتراضي';
  const welcomeMsg = settings.custom_welcome_msg ? 'مخصصة' : 'الافتراضية';
  const thankyouMsg = settings.custom_thankyou_msg ? 'مخصصة' : 'الافتراضية';
  const supportUser = settings.support_username ? `@${settings.support_username.replace('@', '')}` : 'غير محدد';
  const expiryLabel =
    settings.invoice_expiry_hours === 24
      ? '24 ساعة'
      : settings.invoice_expiry_hours === 48
      ? '48 ساعة'
      : settings.invoice_expiry_hours === 168
      ? '7 أيام'
      : 'بلا انتهاء';
  const notifyStatus = settings.notify_on_payment !== false ? 'مفعلة' : 'متوقفة';
  const testModeStatus = settings.test_mode !== false ? '🟡 مفعّل (Sandbox)' : '🟢 معطّل (Live)';

  const text =
    `<b>إعدادات المتجر والفواتير:</b>\n\n` +
    `• اسم النشاط: <b>${bizName}</b>\n` +
    `• رسالة الترحيب: <b>${welcomeMsg}</b>\n` +
    `• رسالة ما بعد الدفع: <b>${thankyouMsg}</b>\n` +
    `• يوزر الدعم الفني: <b>${supportUser}</b>\n` +
    `• صلاحية الفواتير: <b>${expiryLabel}</b>\n` +
    `• إشعارات السداد: <b>${notifyStatus}</b>\n` +
    `• وضع الاختبار: <b>${testModeStatus}</b>\n\n` +
    `اختر القسم المطلوب لتعديله:`;

  const keyboard = new InlineKeyboard()
    .text('تعديل اسم النشاط', 'admin:set:biz_name')
    .text('تعديل رسالة الترحيب', 'admin:set:welcome_msg')
    .row()
    .text('تعديل رسالة ما بعد الدفع', 'admin:set:thankyou_msg')
    .text('تعديل يوزر الدعم', 'admin:set:support_user')
    .row()
    .text(`صلاحية الفواتير: ${expiryLabel}`, 'admin:set:expiry_menu')
    .text(`إشعارات السداد: ${notifyStatus}`, 'admin:set:toggle_notify')
    .row()
    .text(`وضع الاختبار: ${settings.test_mode !== false ? '🟡 مفعّل (Sandbox)' : '🟢 معطّل (Live)'}`, 'admin:set:toggle_test_mode')
    .row()
    .text('الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:set:expiry_menu'
 */
export async function renderExpirySelectionMenu(ctx: any, merchantId: string) {
  const text =
    `<b>تحديد مدة صلاحية الفواتير:</b>\n\n` +
    `اختر المدة التلقائية لانتهاء الفواتير غير المسددة:`;

  const keyboard = new InlineKeyboard()
    .text('بلا انتهاء', 'admin:set_exp:0')
    .row()
    .text('24 ساعة', 'admin:set_exp:24')
    .text('48 ساعة', 'admin:set_exp:48')
    .row()
    .text('7 أيام', 'admin:set_exp:168')
    .row()
    .text('عودة للإعدادات', 'admin:settings');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:analytics' view - Financial Report & CRM
 */
export async function handleAnalyticsView(ctx: any, merchantId: string) {
  const supabase = getSupabase();

  const [invoicesRes, customersRes, paymentsRes] = await Promise.all([
    supabase.from('invoices').select('*').eq('merchant_id', merchantId).is('deleted_at', null),
    supabase.from('customers').select('*').eq('merchant_id', merchantId).order('created_at', { ascending: false }).limit(6),
    supabase.from('payments').select('*').eq('merchant_id', merchantId).eq('status', 'successful'),
  ]);

  const invoices = invoicesRes.data || [];
  const customers = customersRes.data || [];
  const payments = paymentsRes.data || [];

  const realInvoices = invoices.filter((i) => !i.is_test);
  const testInvoices = invoices.filter((i) => i.is_test);

  const realPaidInvoices = realInvoices.filter((i) => i.status === 'paid');
  const realPendingInvoices = realInvoices.filter((i) => i.status === 'pending');

  const realPayments = payments.filter((p) => p.provider !== 'test_sandbox' && !p.is_test);
  const testPayments = payments.filter((p) => p.provider === 'test_sandbox' || p.is_test);

  const totalRealRevenue = realPayments.reduce((acc, p) => acc + (p.amount || 0), 0);
  const avgInvoiceAmount = realPaidInvoices.length > 0 ? Math.round(totalRealRevenue / realPaidInvoices.length) : 0;
  const collectionRate = realInvoices.length > 0 ? Math.round((realPaidInvoices.length / realInvoices.length) * 100) : 0;

  // Revenue by time (Real Stars only)
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const todayRevenue = realPayments
    .filter((p) => now - new Date(p.created_at).getTime() < dayMs)
    .reduce((acc, p) => acc + (p.amount || 0), 0);

  const weekRevenue = realPayments
    .filter((p) => now - new Date(p.created_at).getTime() < 7 * dayMs)
    .reduce((acc, p) => acc + (p.amount || 0), 0);

  const monthRevenue = realPayments
    .filter((p) => now - new Date(p.created_at).getTime() < 30 * dayMs)
    .reduce((acc, p) => acc + (p.amount || 0), 0);

  let text =
    `<b>الإحصائيات والتقرير المالي:</b>\n\n` +
    `<b>مؤشرات الإيرادات الرسمية (⭐️ Stars):</b>\n` +
    `• إجمالي الإيراد المحصل: <b>${totalRealRevenue} ⭐️ Stars</b>\n` +
    `• إيراد اليوم (24 ساعة): <b>${todayRevenue} ⭐️</b>\n` +
    `• إيراد آخر 7 أيام: <b>${weekRevenue} ⭐️</b>\n` +
    `• إيراد آخر 30 يوماً: <b>${monthRevenue} ⭐️</b>\n` +
    `• متوسط قيمة الفاتورة: <b>${avgInvoiceAmount} ⭐️</b>\n\n` +
    `<b>مؤشرات أداء الفواتير الحقيقية:</b>\n` +
    `• إجمالي الفواتير الصادرة: <code>${realInvoices.length}</code>\n` +
    `• الفواتير المسددة: <code>${realPaidInvoices.length}</code>\n` +
    `• الفواتير المعلقة: <code>${realPendingInvoices.length}</code>\n` +
    `• نسبة التحصيل: <b>${collectionRate}%</b>\n`;

  if (testInvoices.length > 0 || testPayments.length > 0) {
    const testVol = testPayments.reduce((acc, p) => acc + (p.amount || 0), 0);
    text += `\n<b>إحصائيات وضع الاختبار (Sandbox):</b>\n`;
    text += `• فواتير التجربة: <code>${testInvoices.length}</code>\n` +
            `• عمليات السداد التجريبية: <code>${testPayments.length}</code> (بقيمة: <code>${testVol}⭐️</code> تجريبية)\n`;
  }

  text += `\n<b>سجل أحدث العملاء (${customers.length}):</b>\n`;
  if (customers.length === 0) {
    text += `<i>لا يوجد عملاء مسجلين حتى الآن.</i>\n`;
  } else {
    for (const c of customers) {
      const name = c.first_name || 'عميل';
      const handle = c.username ? `@${c.username}` : `ID: ${c.telegram_user_id}`;
      text += `• <b>${name}</b> (${handle})\n`;
    }
  }

  const keyboard = new InlineKeyboard()
    .text('تحديث الإحصائيات', 'admin:analytics')
    .row()
    .text('الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles Text Input for all Admin Wizards
 */
export async function handleAdminWizardTextInput(ctx: any, session: AdminSession): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const fromId = ctx.from?.id;
  if (!text || !fromId) return false;

  const { merchantId, botId, botUsername } = session.data;

  // ----------------------------------------------------
  // 1. INVOICE WIZARD
  // ----------------------------------------------------
  if (session.step === 'invoice_title') {
    session.data.invoiceTitle = text;
    session.step = 'invoice_amount';
    setAdminSession(fromId, session);

    const promptText =
      `<b>إنشاء الفاتورة (2/2):</b>\n\n` +
      `• البيان: <b>${text}</b>\n\n` +
      `أدخل المبلغ المطلوب بالنجوم (⭐️ Stars) (مثال: <code>50</code> أو <code>200</code>):`;

    const kb = new InlineKeyboard().text('إلغاء', 'admin:cancel_wizard');
    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  if (session.step === 'invoice_amount') {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('يرجى إدخال رقم صحيح وموجب للمبلغ بالنجوم (مثال: 50):');
      return true;
    }

    session.data.invoiceAmount = amount;
    clearAdminSession(fromId);

    try {
      const settings = await getMerchantSettings(merchantId);
      const isTestMode = settings.test_mode !== false;

      const invoice = await createInvoice({
        merchantId,
        botId,
        title: session.data.invoiceTitle || 'فاتورة جديدة',
        description: undefined,
        totalAmount: amount,
        currency: 'XTR',
        isTest: isTestMode,
      });

      const directPayLink = `https://t.me/${botUsername}?start=inv_${invoice.id}`;

      let successText =
        `<b>تم إنشاء الفاتورة بنجاح</b>\n\n` +
        `• رقم الفاتورة: <code>${invoice.invoice_number}</code>\n` +
        `• البيان: <b>${invoice.title}</b>\n` +
        `• المبلغ: <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
        `• النوع: <b>${isTestMode ? '🟡 تجريبية Sandbox (لم يتم خصم رصيد)' : '🟢 رسمية'}</b>\n\n` +
        `<b>رابط السداد:</b>\n` +
        `<code>${directPayLink}</code>\n`;

      const kb = new InlineKeyboard()
        .url('فتح رابط الفاتورة', directPayLink)
        .row()
        .text('تجربة السداد', `pay:inv:${invoice.id}`)
        .row()
        .text('سجل الفواتير', 'admin:invoices')
        .text('الرئيسية', 'admin:main_menu');

      await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
      await ctx.reply(`تعذر إنشاء الفاتورة: ${err?.message || 'خطأ غير معروف'}`);
    }
    return true;
  }

  // ----------------------------------------------------
  // 2. SETTINGS WIZARDS
  // ----------------------------------------------------
  if (session.step === 'set_biz_name') {
    clearAdminSession(fromId);
    await updateMerchantSettings(merchantId, { business_name: text });
    await ctx.reply(`تم حفظ اسم النشاط: <b>${text}</b>`, { parse_mode: 'HTML' });
    await handleSettingsView(ctx, merchantId, botUsername, botId);
    return true;
  }

  if (session.step === 'set_welcome_msg') {
    clearAdminSession(fromId);
    await updateMerchantSettings(merchantId, { custom_welcome_msg: text });
    await ctx.reply(`تم حفظ رسالة الترحيب المخصصة.`, { parse_mode: 'HTML' });
    await handleSettingsView(ctx, merchantId, botUsername, botId);
    return true;
  }

  if (session.step === 'set_thankyou_msg') {
    clearAdminSession(fromId);
    await updateMerchantSettings(merchantId, { custom_thankyou_msg: text });
    await ctx.reply(`تم حفظ رسالة ما بعد الدفع المخصصة.`, { parse_mode: 'HTML' });
    await handleSettingsView(ctx, merchantId, botUsername, botId);
    return true;
  }

  if (session.step === 'set_support_user') {
    clearAdminSession(fromId);
    const cleaned = text.replace('@', '').trim();
    await updateMerchantSettings(merchantId, { support_username: cleaned });
    await ctx.reply(`تم تعيين يوزر الدعم: <b>@${cleaned}</b>`, { parse_mode: 'HTML' });
    await handleSettingsView(ctx, merchantId, botUsername, botId);
    return true;
  }

  return false;
}

/**
 * Handles 'admin:subscription' view
 */
export async function handleSubscriptionView(ctx: any, merchantId: string) {
  const supabase = getSupabase();

  const [usageRes, subRes, platformUsername] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
    getPlatformBotUsername(),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const plan = sub?.plans;

  const base = usage?.base_operations ?? 10;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);

  const resetDate = usage?.cycle_reset_at ? new Date(usage.cycle_reset_at).toLocaleDateString('ar-EG') : 'غير محدد';

  const text =
    `<b>تفاصيل الاشتراك والرصيد:</b>\n\n` +
    `• الخطة الحالية: <b>${plan?.name || 'Free Starter'}</b>\n` +
    `• الرصيد الأساسي للدورة: <code>${base}</code> عملية\n` +
    `• الرصيد الإضافي (Bonus): <code>${bonus}</code> عملية (صلاحية 30 يوماً)\n` +
    `• العمليات المستهلكة: <code>${used}</code> عملية\n` +
    `• <b>الرصيد المتاح حالياً:</b> <b>${available}</b> عملية\n` +
    `• تاريخ انتهاء الدورة / التجديد: <code>${resetDate}</code>\n` +
    `• حالة الاشتراك: <b>${sub?.status === 'active' ? 'نشط' : 'متوقف'}</b>\n\n` +
    `<i>ملاحظة: شحن أي رصيد إضافي يمنحك صلاحية شهر كامل (30 يوماً) من تاريخ الشحن.</i>`;

  const subLink = `https://t.me/${platformUsername.replace('@', '')}?start=sub_${merchantId}`;

  const keyboard = new InlineKeyboard()
    .url('شحن رصيد / ترقية الباقة (30 يوماً)', subLink)
    .row()
    .text('تحديث الرصيد', 'admin:subscription')
    .row()
    .text('الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
