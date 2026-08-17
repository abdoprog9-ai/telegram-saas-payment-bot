import { InlineKeyboard } from 'grammy';
import { getSupabase } from '../database/supabase.js';
import { createInvoice } from '../services/invoice-service.js';

export interface AdminSession {
  step:
    | 'invoice_title'
    | 'invoice_desc'
    | 'invoice_amount';
  data: {
    merchantId: string;
    botId: string;
    botUsername: string;
    invoiceTitle?: string;
    invoiceDesc?: string;
    invoiceAmount?: number;
  };
}

// In-Memory Session Store for Admin Invoicing Wizard
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
 * Builds the Main Admin Dashboard Inline Keyboard (Focused purely on Invoicing & Payments)
 */
export function buildAdminMainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ إنشاء فاتورة جديدة', 'admin:create_invoice')
    .row()
    .text('📄 سجل الفواتير', 'admin:invoices')
    .text('💳 اشتراكي ورصيدي', 'admin:subscription')
    .row()
    .text('⚙️ الإعدادات', 'admin:settings')
    .text('🔄 تحديث', 'admin:refresh');
}

/**
 * Handles the /start or /admin command for Merchant Bot Admin
 */
export async function renderAdminDashboard(ctx: any, merchantId: string, botUsername: string, isRefresh = false) {
  const supabase = getSupabase();
  const fromId = ctx.from?.id;
  if (fromId) clearAdminSession(fromId);

  // Fetch usage, subscription, and invoice statistics
  const [usageRes, subRes, totalInvoicesRes, paidInvoicesRes] = await Promise.all([
    supabase.from('usage').select('*').eq('merchant_id', merchantId).single(),
    supabase.from('subscriptions').select('*, plans(*)').eq('merchant_id', merchantId).single(),
    supabase.from('invoices').select('id', { count: 'exact' }).eq('merchant_id', merchantId).is('deleted_at', null),
    supabase.from('invoices').select('id, total_amount').eq('merchant_id', merchantId).eq('status', 'paid').is('deleted_at', null),
  ]);

  const usage = usageRes.data;
  const sub = subRes.data;
  const planName = sub?.plans?.name || 'Free Starter';

  const base = usage?.base_operations ?? 20;
  const bonus = usage?.bonus_credits ?? 0;
  const used = usage?.operations_used ?? 0;
  const available = Math.max(0, (base + bonus) - used);
  const totalInvoices = totalInvoicesRes.count ?? 0;
  const paidInvoicesList = paidInvoicesRes.data || [];
  const paidCount = paidInvoicesList.length;
  const totalCollectedStars = paidInvoicesList.reduce((acc, inv) => acc + (inv.total_amount || 0), 0);

  const text =
    `👑 <b>لوحة تحكم الفواتير والمدفوعات | @${botUsername}</b>\n\n` +
    `📊 <b>ملخص الحساب والفواتير:</b>\n` +
    `• الخطة الحالية: <b>${planName}</b>\n` +
    `• رصيد العمليات المتاح: <b>${available}</b> (المستهلك: ${used})\n` +
    `• إجمالي الفواتير المنشأة: <b>${totalInvoices}</b> فاتورة\n` +
    `• الفواتير المسددة: <b>${paidCount}</b> (إجمالي المحصل: <b>${totalCollectedStars} ⭐️</b>)\n` +
    `• حالة البوت: <b>${sub?.status === 'active' ? '🟢 جاهز لاستقبال المدفوعات' : '🔴 متوقف مؤقتاً'}</b>\n\n` +
    `اضغط على <b>➕ إنشاء فاتورة جديدة</b> لإنشاء فاتورة ومشاركتها فورياً مع عميلك:`;

  const keyboard = buildAdminMainMenu();

  if (isRefresh && ctx.answerCallbackQuery) {
    await ctx.answerCallbackQuery({ text: '✅ تم تحديث البيانات بنجاح!' }).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles 'admin:invoices' view - lists invoices with interactive detail buttons
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

  let text = `📄 <b>سجل وإدارة الفواتير:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (!invoices || invoices.length === 0) {
    text += `<i>لا توجد فواتير منشأة حالياً. يمكنك إنشاء أول فاتورة فورياً ومشاركتها مع عميلك برابط مباشر لسدادها بالنجوم!</i>\n\n`;
  } else {
    text += `اضغط على أي فاتورة لعرض تفاصيلها، رابط سدادها، أو إدارتها:\n\n`;
    for (const inv of invoices) {
      const statusIcon = inv.status === 'paid' ? '🟢' : inv.status === 'pending' ? '🟡' : '🔴';
      keyboard.text(`${statusIcon} ${inv.invoice_number} | ${inv.title} (${inv.total_amount}⭐️)`, `admin:view_inv:${inv.id}`).row();
    }
  }

  keyboard
    .text('➕ إنشاء فاتورة جديدة', 'admin:create_invoice')
    .row()
    .text('🔄 تحديث القائمة', 'admin:invoices')
    .text('🔙 الرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders full details for a specific invoice with sharing link and action buttons
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
    const text = `⚠️ <b>عذراً، هذه الفاتورة غير موجودة أو تم حذفها مسبقاً.</b>`;
    const kb = new InlineKeyboard().text('🔙 سجل الفواتير', 'admin:invoices');
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  const directPayLink = `https://t.me/${botUsername}?start=inv_${invoice.id}`;
  const statusLabel = invoice.status === 'paid' ? '🟢 مسددة بنجاح' : invoice.status === 'pending' ? '🟡 بانتظار السداد' : '🔴 ملغاة';
  const createdDate = new Date(invoice.created_at).toLocaleString('ar-EG');
  const paidDate = invoice.paid_at ? new Date(invoice.paid_at).toLocaleString('ar-EG') : null;

  const text =
    `📄 <b>تفاصيل الفاتورة | ${invoice.invoice_number}</b>\n\n` +
    `• <b>البيان / الخدمة:</b> ${invoice.title}\n` +
    (invoice.description ? `• <b>التفاصيل:</b> ${invoice.description}\n` : '') +
    `• <b>المبلغ المطلوب:</b> <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
    `• <b>الحالة:</b> ${statusLabel}\n` +
    `• <b>تاريخ الإنشاء:</b> <code>${createdDate}</code>\n` +
    (paidDate ? `• <b>تاريخ السداد:</b> <code>${paidDate}</code>\n` : '') +
    `\n🔗 <b>رابط السداد المباشر للعميل:</b>\n<code>${directPayLink}</code>\n\n` +
    `💡 <i>شارك هذا الرابط مع عميلك في أي وقت ليسدد الفاتورة بنجوم تيليجرام فورياً!</i>`;

  const keyboard = new InlineKeyboard()
    .url('🔗 فتح رابط الفاتورة', directPayLink)
    .row();

  if (invoice.status === 'pending') {
    keyboard
      .text('⭐️ تجربة سداد الفاتورة', `pay:inv:${invoice.id}`)
      .text('🗑️ إلغاء الفاتورة', `admin:del_inv:${invoice.id}`)
      .row();
  }

  keyboard
    .text('🔙 سجل الفواتير', 'admin:invoices')
    .text('🏠 الرئيسية', 'admin:main_menu');

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
    await ctx.answerCallbackQuery({ text: '🗑️ تم إلغاء وحذف الفاتورة بنجاح!' }).catch(() => {});
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
    `📝 <b>إنشاء فاتورة جديدة (الخطوة 1 من 2):</b>\n\n` +
    `أدخل <b>عنوان أو بيان الفاتورة</b> (مثال: استشارة تقنية / خدمة تصميم / صيانة موقع):`;

  const keyboard = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles Text Input for the Invoicing Wizard
 */
export async function handleAdminWizardTextInput(ctx: any, session: AdminSession): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const fromId = ctx.from?.id;
  if (!text || !fromId) return false;

  const { merchantId, botId, botUsername } = session.data;

  // Step 1: Invoice Title
  if (session.step === 'invoice_title') {
    session.data.invoiceTitle = text;
    session.step = 'invoice_amount';
    setAdminSession(fromId, session);

    const promptText =
      `📝 <b>إنشاء الفاتورة (الخطوة 2 من 2):</b>\n\n` +
      `• البيان: <b>${text}</b>\n\n` +
      `أدخل الآن <b>المبلغ المطلوب سداده بالنجوم (⭐️ Stars)</b> (أرقام فقط، مثال: <code>50</code> أو <code>100</code>):`;

    const kb = new InlineKeyboard().text('❌ إلغاء', 'admin:cancel_wizard');
    await ctx.reply(promptText, { parse_mode: 'HTML', reply_markup: kb });
    return true;
  }

  // Step 2: Invoice Amount (Creates invoice immediately!)
  if (session.step === 'invoice_amount') {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('⚠️ يرجى إدخال رقم صحيح وموجب للمبلغ بالنجوم (مثال: 25 أو 100):');
      return true;
    }

    session.data.invoiceAmount = amount;
    clearAdminSession(fromId);

    try {
      const invoice = await createInvoice({
        merchantId,
        botId,
        title: session.data.invoiceTitle || 'فاتورة جديدة',
        description: undefined,
        totalAmount: amount,
        currency: 'XTR',
      });

      const directPayLink = `https://t.me/${botUsername}?start=inv_${invoice.id}`;

      const successText =
        `🎉 <b>تم إنشاء الفاتورة بنجاح!</b>\n\n` +
        `• <b>رقم الفاتورة:</b> <code>${invoice.invoice_number}</code>\n` +
        `• <b>البيان:</b> ${invoice.title}\n` +
        `• <b>المبلغ:</b> <b>${invoice.total_amount} ⭐️ Stars</b>\n` +
        `• <b>الحالة:</b> 🟡 بانتظار السداد\n\n` +
        `🔗 <b>رابط السداد المباشر للعميل:</b>\n` +
        `<code>${directPayLink}</code>\n\n` +
        `💡 <i>بمجرد أن يضغط العميل على هذا الرابط في تيليجرام، سيفتح له البوت مباشرة ويطلب منه الدفع بالنجوم في ثانية واحدة!</i>`;

      const kb = new InlineKeyboard()
        .url('🔗 فتح رابط الفاتورة', directPayLink)
        .row()
        .text('⭐️ تجربة سداد الفاتورة بنفسك', `pay:inv:${invoice.id}`)
        .row()
        .text('📄 سجل الفواتير', 'admin:invoices')
        .text('🏠 الرئيسية', 'admin:main_menu');

      await ctx.reply(successText, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
      await ctx.reply(`⚠️ تعذر إنشاء الفاتورة: ${err?.message || 'خطأ غير معروف'}`);
    }
    return true;
  }

  return false;
}

/**
 * Handles 'admin:subscription' view
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
    `💳 <b>تفاصيل اشتراكي والرصيد:</b>\n\n` +
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
 * Handles 'admin:settings' view
 */
export async function handleSettingsView(ctx: any, botUsername: string, botId: string) {
  const text =
    `⚙️ <b>إعدادات وحالة البوت:</b>\n\n` +
    `• معرف البوت: <code>@${botUsername}</code>\n` +
    `• معرف النظام (UUID): <code>${botId}</code>\n` +
    `• التشفير: 🔒 <b>AES-256-GCM نشط</b>\n` +
    `• نظام الـ Webhook: 🟢 <b>متصل وفوري</b>\n` +
    `• الدفع بالنجوم: ⭐ <b>مفعل (Telegram Stars XTR)</b>\n\n` +
    `💡 <i>جميع البيانات محمية بنظام العزل المتعدد (Multi-Tenant).</i>`;

  const keyboard = new InlineKeyboard().text('🔙 العودة للرئيسية', 'admin:main_menu');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
